import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { detectFirewall, lanAddresses, openCommands } from '../src/ports/firewall';
import { checkFromInternet, publicIp, type Fetch } from '../src/ports/reach';
import { isPrivateAddress, localAddressFor, parseDescription, Upnp } from '../src/ports/upnp';
import { fakeRouter, type FakeRouter } from './fake-igd';

const routers: FakeRouter[] = [];
after(() => Promise.all(routers.map((r) => r.close())));
const router = async (opts = {}) => {
  const r = await fakeRouter(opts);
  routers.push(r);
  return { r, upnp: new Upnp({ ssdpHost: '127.0.0.1', ssdpPort: r.ssdpPort, timeoutMs: 800 }) };
};

describe('UPnP', () => {
  it('reads the WAN service out of a device description', () => {
    const xml = '<root><URLBase>http://192.168.1.1:5000/</URLBase><friendlyName>Box</friendlyName><service><serviceType>urn:x:service:WANPPPConnection:1</serviceType><controlURL>/ppp</controlURL></service><service><serviceType>urn:x:service:WANIPConnection:2</serviceType><controlURL>ip2</controlURL></service></root>';
    const d = parseDescription(xml, 'http://192.168.1.1:5000/desc.xml');
    assert.deepEqual(d, { name: 'Box', controlUrl: 'http://192.168.1.1:5000/ip2', serviceType: 'urn:x:service:WANIPConnection:2' }, 'the newest IP service is preferred');
    assert.equal(parseDescription('<root><service><serviceType>urn:x:service:Other:1</serviceType><controlURL>/o</controlURL></service></root>', 'http://a/'), null);
    assert.equal(parseDescription('<root><service><serviceType>urn:x:service:WANIPConnection:1</serviceType><controlURL>/c</controlURL></service></root>', 'http://10.0.0.1:80/d.xml')?.controlUrl, 'http://10.0.0.1/c', 'without URLBase the location is the base');
  });

  it('finds the router, opens and closes a port', async () => {
    const { r, upnp } = await router();
    const gw = await upnp.discover();
    assert.equal(gw?.name, 'Test Router');
    assert.equal(gw?.host, '127.0.0.1');
    assert.equal(await upnp.externalIp(gw), '203.0.113.9');
    await upnp.open(gw, 25565, '192.168.1.50', 'MCNetwork', 3600);
    assert.deepEqual(r.mappings.get('25565/TCP'), { NewRemoteHost: '', NewExternalPort: '25565', NewProtocol: 'TCP', NewInternalPort: '25565', NewInternalClient: '192.168.1.50', NewEnabled: '1', NewPortMappingDescription: 'MCNetwork', NewLeaseDuration: '3600' });
    await upnp.close(gw, 25565);
    assert.equal(r.mappings.size, 0);
    await upnp.close(gw, 25565); // "no such mapping" is fine
  });

  it('retries with a permanent lease when the router only knows those', async () => {
    const { r, upnp } = await router({ onlyPermanent: true });
    const gw = (await upnp.discover())!;
    await upnp.open(gw, 25565, '192.168.1.50');
    assert.equal(r.mappings.get('25565/TCP')?.NewLeaseDuration, '0');
    assert.deepEqual(r.calls.filter((c) => c.action === 'AddPortMapping').map((c) => c.args.NewLeaseDuration), ['3600', '0']);
  });

  it('reports what the router refuses, and finds nobody when nobody answers', async () => {
    const { upnp } = await router({ refuse: true });
    const gw = (await upnp.discover())!;
    await assert.rejects(() => upnp.open(gw, 25565, '192.168.1.50'), /Action Failed/);
    const silent = new Upnp({ ssdpHost: '127.0.0.1', ssdpPort: 9, timeoutMs: 300 });
    assert.equal(await silent.discover(), null);
  });

  it('knows private and carrier-grade addresses, and this machine\'s address towards a host', async () => {
    for (const ip of ['10.1.2.3', '192.168.0.5', '172.20.1.1', '100.64.0.9', '100.127.1.1', '169.254.1.1', '127.0.0.1']) assert.equal(isPrivateAddress(ip), true, ip);
    for (const ip of ['203.0.113.9', '8.8.8.8', '172.32.0.1', '100.128.0.1', 'not an ip']) assert.equal(isPrivateAddress(ip), false, ip);
    assert.equal(await localAddressFor('127.0.0.1'), '127.0.0.1');
    assert.ok(Array.isArray(lanAddresses()));
  });
});

describe('firewall detection', () => {
  it('gives the right command for each tool', () => {
    assert.deepEqual(openCommands('ufw', 25565), ['sudo ufw allow 25565/tcp']);
    assert.deepEqual(openCommands('firewalld', 25565), ['sudo firewall-cmd --permanent --add-port=25565/tcp', 'sudo firewall-cmd --reload']);
    assert.match(openCommands('iptables', 25565)[0], /--dport 25565 -j ACCEPT/);
    assert.match(openCommands('windows', 25565)[0], /netsh advfirewall firewall add rule name="MCNetwork 25565".*localport=25565/);
    assert.deepEqual(openCommands(null, 25565), []);
    assert.deepEqual(openCommands('macos', 25565), []);
  });

  it('detects ufw and whether it is active', async () => {
    const on = await detectFirewall(25565, (c, a) => Promise.resolve(c === 'ufw' ? (a[0] === 'status' ? 'Status: active\n' : 'ufw 0.36') : null), 'linux', false);
    assert.deepEqual({ tool: on.tool, active: on.active, commands: on.commands }, { tool: 'ufw', active: true, commands: ['sudo ufw allow 25565/tcp'] });
    const off = await detectFirewall(25565, (c, a) => Promise.resolve(c === 'ufw' ? (a[0] === 'status' ? 'Status: inactive' : 'ufw') : null), 'linux', false);
    assert.equal(off.active, false);
    assert.match(off.note ?? '', /switched off/);
    const unknown = await detectFirewall(25565, (c, a) => Promise.resolve(c === 'ufw' && a[0] === 'version' ? 'ufw' : null), 'linux', false);
    assert.equal(unknown.active, null, 'without rights the state is unknown');
  });

  it('detects firewalld, iptables, Windows, macOS and nothing', async () => {
    const fw = await detectFirewall(1, (c, a) => Promise.resolve(c === 'firewall-cmd' ? (a[0] === '--state' ? 'running' : '1.2') : null), 'linux', false);
    assert.deepEqual({ tool: fw.tool, active: fw.active }, { tool: 'firewalld', active: true });
    assert.equal((await detectFirewall(1, (c) => Promise.resolve(c === 'iptables' ? 'v1.8' : null), 'linux', false)).tool, 'iptables');
    const win = await detectFirewall(25565, () => Promise.resolve('State                                 ON'), 'win32', false);
    assert.deepEqual({ tool: win.tool, active: win.active }, { tool: 'windows', active: true });
    assert.equal((await detectFirewall(1, () => Promise.resolve(null), 'win32', false)).active, null);
    const mac = await detectFirewall(1, () => Promise.resolve(null), 'darwin', false);
    assert.equal(mac.tool, 'macos');
    assert.match(mac.note ?? '', /asks to allow incoming/);
    const none = await detectFirewall(25570, () => Promise.resolve(null), 'linux', false);
    assert.deepEqual({ tool: none.tool, commands: none.commands }, { tool: null, commands: [] });
    assert.match(none.note ?? '', /port 25570/);
    assert.match((await detectFirewall(25565, () => Promise.resolve(null), 'linux', true)).note ?? '', /container/);
  });
});

describe('reachability check', () => {
  const reply = (body: unknown, status = 200): Fetch => () => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body), text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)) });

  it('asks the status service and reports what it saw', async () => {
    const urls: string[] = [];
    const fetchFn: Fetch = (url, init) => {
      urls.push(url);
      return reply({ online: true, version: 'Velocity 1.7.2-26.2', motd: { clean: ['My Network'] } })(url, init);
    };
    const r = await checkFromInternet('203.0.113.9', 25565, fetchFn);
    assert.deepEqual(r, { ip: '203.0.113.9', port: 25565, online: true, version: 'Velocity 1.7.2-26.2', motd: 'My Network', hints: [] });
    assert.deepEqual(urls, ['https://api.mcsrvstat.us/3/203.0.113.9:25565']);
  });

  it('explains what to look at when it is not reachable', async () => {
    const r = await checkFromInternet('203.0.113.9', 25565, reply({ online: false }));
    assert.equal(r.online, false);
    assert.ok(r.hints.some((h) => /router forwarding the TCP port/.test(h)));
    assert.ok((await checkFromInternet('100.70.1.1', 25565, reply({ online: false }))).hints[0].includes('CGNAT'));
    await assert.rejects(() => checkFromInternet('1.2.3.4', 1, reply({}, 503)), /answered 503/);
  });

  it('finds the public address', async () => {
    assert.equal(await publicIp(reply('198.51.100.7\n')), '198.51.100.7');
    await assert.rejects(() => publicIp(reply('<html>nope</html>')), /Could not find out/);
    await assert.rejects(() => publicIp(reply('x', 500)), /Could not find out/);
  });
});
