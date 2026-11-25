import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { createHttpServer } from '../src/http/server';
import { portOverview, changePort } from '../src/ports/manager';
import type { Fetch } from '../src/ports/reach';
import { Upnp } from '../src/ports/upnp';
import { BACKUP_DIR } from '../src/setup/importer';
import type { ServerConfig } from '../src/types';
import { fakeRouter, type FakeRouter } from './fake-igd';
import { makeNetwork, server } from './helpers';

const FIX = join(process.cwd(), 'test', 'fixtures');
const routers: FakeRouter[] = [];
after(() => Promise.all(routers.map((r) => r.close())));

const reply = (body: unknown): Fetch => () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)) });

/** A network with a proxy (port 41111) and two game servers whose files are written the way the setup writes them. */
async function ports(opts: { servers?: ServerConfig[]; fetch?: Fetch; routerOpts?: Parameters<typeof fakeRouter>[0] } = {}) {
  const router = await fakeRouter(opts.routerOpts);
  routers.push(router);
  const servers = opts.servers ?? [server('proxy', { role: 'proxy', autoStart: false, port: 41111 }), server('lobby', { autoStart: false, port: 41112, entry: true }), server('survival', { autoStart: false, port: 41113 })];
  const made = makeNetwork(servers, {}, {
    portTools: { upnp: new Upnp({ ssdpHost: '127.0.0.1', ssdpPort: router.ssdpPort, timeoutMs: 800 }), localAddress: () => Promise.resolve('192.168.1.50'), run: () => Promise.resolve(null), lan: () => [{ name: 'eth0', address: '192.168.1.50' }], fetch: opts.fetch ?? reply({ online: true }), platform: 'linux', inContainer: false, renewMs: 60_000 },
  });
  const { dir } = made;
  for (const s of servers) {
    const d = join(dir, s.dir);
    mkdirSync(d, { recursive: true });
    if (s.role === 'proxy') writeFileSync(join(d, 'velocity.toml'), readFileSync(join(FIX, 'velocity-3.5.1.toml'), 'utf8').replace('0.0.0.0:25565', `0.0.0.0:${s.port}`).replace(/(\[query\][\s\S]*?\nport = )25565/, `$1${s.port}`));
    else writeFileSync(join(d, 'server.properties'), `server-port=${s.port}\nserver-ip=${s.standalone ? '' : '127.0.0.1'}\nonline-mode=false\n`);
  }
  await made.net.start();
  return { ...made, router };
}

const read = (...p: string[]) => readFileSync(join(...p), 'utf8');
interface SavedConfig {
  ports: { upnp: boolean };
  servers: { id: string; port: number }[];
}
const saved = (dir: string) => JSON.parse(read(dir, 'mcnetwork.json')) as SavedConfig;

describe('port overview', () => {
  it('lists every server with where it listens and what is wrong', async () => {
    const { net } = await ports();
    const { rows, publicPort } = await portOverview(net);
    assert.equal(publicPort, 41111);
    assert.deepEqual(rows.map((r) => [r.id, r.port, r.exposure, r.listening, r.issues.length]), [['proxy', 41111, 'public', false, 0], ['lobby', 41112, 'local', false, 0], ['survival', 41113, 'local', false, 0]]);
  });

  it('warns about a game server that anybody could join directly, and offers the fix', async () => {
    const { net, dir } = await ports();
    writeFileSync(join(dir, 'servers', 'lobby', 'server.properties'), 'server-port=41112\nserver-ip=\nonline-mode=false\n');
    const lobby = (await portOverview(net)).rows.find((r) => r.id === 'lobby')!;
    assert.equal(lobby.exposure, 'public');
    assert.equal(lobby.canMakeLocal, true);
    assert.match(lobby.issues[0], /skip the proxy/);
    const view = await changePort(net, 'lobby', { localOnly: true });
    assert.equal(view.config.port, 41112);
    assert.match(read(dir, 'servers', 'lobby', 'server.properties'), /server-ip=127\.0\.0\.1/);
    assert.deepEqual((await portOverview(net)).rows.find((r) => r.id === 'lobby')!.issues, []);
  });

  it('notices double ports, a proxy that is local only, and another program on a stopped server\'s port', async () => {
    const { net, dir } = await ports({ servers: [server('proxy', { role: 'proxy', autoStart: false, port: 41121 }), server('a', { autoStart: false, port: 41122 }), server('b', { autoStart: false, port: 41122 })] });
    writeFileSync(join(dir, 'servers', 'proxy', 'velocity.toml'), 'bind = "127.0.0.1:41121"\n');
    const busy = createServer();
    await new Promise<void>((r) => busy.listen(41122, '127.0.0.1', r));
    try {
      const rows = (await portOverview(net)).rows;
      assert.match(rows[0].issues.join(' '), /only listens on this machine/);
      assert.match(rows[1].issues.join(' '), /more than one server/);
      assert.match(rows[1].issues.join(' '), /Another program is using port 41122/);
    } finally {
      await new Promise<void>((r) => busy.close(() => r()));
    }
  });

  it('leaves standalone servers out of the exposure warning', async () => {
    const { net } = await ports({ servers: [server('proxy', { role: 'proxy', autoStart: false, port: 41131 }), server('modded', { autoStart: false, port: 41132, standalone: true })] });
    assert.deepEqual((await portOverview(net)).rows[1].issues, []);
  });
});

describe('changing a port', () => {
  it('moves a game server: its files, the config and the proxy list', async () => {
    const { net, dir } = await ports();
    // the proxy has to know the servers: write the list once the way the setup does
    await net.syncProxy();
    const view = await changePort(net, 'survival', { port: 41150 });
    assert.equal(view.config.port, 41150);
    assert.match(read(dir, 'servers', 'survival', 'server.properties'), /server-port=41150/);
    assert.match(read(dir, 'servers', 'proxy', 'velocity.toml'), /^survival = "127\.0\.0\.1:41150"$/m);
    assert.equal(saved(dir).servers.find((s) => s.id === 'survival')?.port, 41150);
  });

  it('moves the proxy: bind and query port', async () => {
    const { net, dir } = await ports();
    await changePort(net, 'proxy', { port: 41160 });
    const toml = read(dir, 'servers', 'proxy', 'velocity.toml');
    assert.match(toml, /^bind = "0\.0\.0\.0:41160"$/m);
    assert.match(toml, /\[query\][\s\S]*?\nport = 41160\n/);
    assert.equal((await portOverview(net)).publicPort, 41160);
  });

  it('refuses what cannot work', async () => {
    const { net } = await ports();
    await assert.rejects(() => changePort(net, 'lobby', { port: 41113 }), /belongs to "survival"/);
    await assert.rejects(() => changePort(net, 'lobby', { port: 0 }), /1 to 65535/);
    await assert.rejects(() => changePort(net, 'lobby', { port: 70000 }), /1 to 65535/);
    await assert.rejects(() => changePort(net, 'lobby', {}), /Nothing to change/);
    await assert.rejects(() => changePort(net, 'proxy', { localOnly: true }), /proxy has to be reachable/);
    await assert.rejects(() => changePort(net, 'ghost', { port: 41170 }), /Unknown server/);
    const busy = createServer();
    await new Promise<void>((r) => busy.listen(41171, '127.0.0.1', r));
    try {
      await assert.rejects(() => changePort(net, 'lobby', { port: 41171 }), /Another program is already using port 41171/);
    } finally {
      await new Promise<void>((r) => busy.close(() => r()));
    }
    await net.startServer('lobby');
    await net.instance('lobby').refresh();
    await assert.rejects(() => changePort(net, 'lobby', { port: 41172 }), /Stop the server first/);
  });

  it('saves the original of an imported server\'s file first', async () => {
    const { net, dir } = await ports({ servers: [server('proxy', { role: 'proxy', autoStart: false, port: 41181 }), server('old', { autoStart: false, port: 41182, imported: true })] });
    await changePort(net, 'old', { port: 41183 });
    const saved = join(dir, 'servers', 'old', BACKUP_DIR);
    assert.match(read(saved, readdirSync(saved)[0], 'server.properties'), /server-port=41182/);
  });
});

describe('making the proxy reachable', () => {
  it('tells what is needed: port, running, addresses, firewall', async () => {
    const { net } = await ports();
    const info = await net.access.info();
    assert.deepEqual({ port: info.proxyPort, running: info.proxyRunning, lan: info.lan, tool: info.firewall?.tool, upnp: info.upnp, address: info.address, cgnat: info.carrierNat }, { port: 41111, running: false, lan: [{ name: 'eth0', address: '192.168.1.50' }], tool: null, upnp: { enabled: false, mapping: null, error: null }, address: null, cgnat: false });
  });

  it('finds the router, forwards the port and remembers to keep it open', async () => {
    const { net, dir, router } = await ports();
    const found = await net.access.discover();
    assert.deepEqual(found, { found: true, router: 'Test Router', host: '127.0.0.1', externalIp: '203.0.113.9', carrierNat: false });
    const mapping = await net.access.open();
    assert.deepEqual({ port: mapping.port, router: mapping.router, ip: mapping.externalIp, client: mapping.internalClient }, { port: 41111, router: 'Test Router', ip: '203.0.113.9', client: '192.168.1.50' });
    assert.equal(router.mappings.get('41111/TCP')?.NewInternalClient, '192.168.1.50');
    assert.equal(saved(dir).ports.upnp, true);
    const info = await net.access.info();
    assert.equal(info.address, '203.0.113.9:41111');
    await net.access.close();
    assert.equal(router.mappings.size, 0);
    assert.equal(saved(dir).ports.upnp, false);
    assert.equal(net.access.mapping, null);
  });

  it('says why it could not open the port', async () => {
    const { net } = await ports({ routerOpts: { refuse: true } });
    await assert.rejects(() => net.access.open(), /router refused the mapping: Action Failed/);
    assert.match((await net.access.info()).upnp.error ?? '', /Action Failed/);
    const { net: none } = makeNetwork([server('lobby', { autoStart: false })], {}, { portTools: { upnp: new Upnp({ ssdpHost: '127.0.0.1', ssdpPort: 9, timeoutMs: 200 }) } });
    await none.start();
    await assert.rejects(() => none.access.open(), /no proxy yet/);
    const { net: noRouter } = makeNetwork([server('proxy', { role: 'proxy', autoStart: false, port: 41191 })], {}, { portTools: { upnp: new Upnp({ ssdpHost: '127.0.0.1', ssdpPort: 9, timeoutMs: 200 }) } });
    await noRouter.start();
    await assert.rejects(() => noRouter.access.open(), /No router answered/);
    assert.deepEqual(await noRouter.access.discover(), { found: false });
  });

  it('moves the router mapping when the proxy gets another port, and gives it back when the daemon stops', async () => {
    const { net, dir, router } = await ports();
    await net.access.open();
    await changePort(net, 'proxy', { port: 41200 });
    assert.deepEqual([...router.mappings.keys()], ['41200/TCP']);
    await net.stop();
    assert.equal(router.mappings.size, 0, 'the port is given back');
    assert.equal(saved(dir).ports.upnp, true, 'but it is opened again at the next start');
  });

  it('opens the port again at start when it was open before', async () => {
    const router = await fakeRouter();
    routers.push(router);
    const { net } = makeNetwork([server('proxy', { role: 'proxy', autoStart: false, port: 41210 })], { ports: { upnp: true } }, { portTools: { upnp: new Upnp({ ssdpHost: '127.0.0.1', ssdpPort: router.ssdpPort, timeoutMs: 800 }), localAddress: () => Promise.resolve('192.168.1.50') } });
    mkdirSync(join(net.dataDir, 'servers', 'proxy'), { recursive: true });
    await net.start();
    await waitUntil(() => router.mappings.has('41210/TCP'));
    assert.ok(net.access.mapping);
  });

  it('checks from the internet, and spares the service when the address cannot be public', async () => {
    const asked: string[] = [];
    const { net } = await ports({ fetch: (url, init) => { asked.push(url); return reply({ online: true, version: 'Velocity', motd: { clean: ['Hi'] } })(url, init); } });
    await net.access.open();
    const r = await net.access.check();
    assert.deepEqual({ ip: r.ip, port: r.port, online: r.online }, { ip: '203.0.113.9', port: 41111, online: true });
    assert.deepEqual(asked, ['https://api.mcsrvstat.us/3/203.0.113.9:41111']);

    const cg = await ports({ routerOpts: { externalIp: '100.70.0.5' }, fetch: (url) => { throw new Error(`must not ask ${url}`); } });
    await cg.net.access.open();
    assert.equal((await cg.net.access.info()).carrierNat, true);
    const result = await cg.net.access.check();
    assert.equal(result.online, false);
    assert.match(result.hints[0], /CGNAT/);

    const manual = await ports({ fetch: (url, init) => reply(url.includes('ipify') ? '198.51.100.7' : { online: false })(url, init) });
    assert.equal((await manual.net.access.check()).ip, '198.51.100.7', 'without a mapping the public address is asked for');
  });
});

async function waitUntil(cond: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('ports over HTTP', () => {
  it('serves the overview, changes a port and walks through the access steps', async () => {
    const { net } = await ports();
    const http = createHttpServer(net, { host: '127.0.0.1', port: 0, token: '' });
    const port = await http.listen();
    after(() => http.close());
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : undefined };
    };
    const overview = (await call('GET', '/api/ports')).json as { publicPort: number; rows: { id: string }[] };
    assert.equal(overview.publicPort, 41111);
    assert.deepEqual(overview.rows.map((r) => r.id), ['proxy', 'lobby', 'survival']);
    assert.equal((await call('POST', '/api/servers/survival/port', { port: 41300 })).status, 200);
    assert.equal((await call('POST', '/api/servers/survival/port', { port: 41111 })).status, 400);
    assert.equal((await call('POST', '/api/servers/survival/port', {})).status, 400);
    assert.equal((await call('POST', '/api/servers/ghost/port', { port: 41301 })).status, 404);

    const access = (await call('GET', '/api/ports/access')).json as { proxyPort: number; lan: unknown[] };
    assert.equal(access.proxyPort, 41111);
    assert.equal(((await call('POST', '/api/ports/upnp/discover')).json as { found: boolean }).found, true);
    assert.equal(((await call('POST', '/api/ports/upnp/open')).json as { port: number }).port, 41111);
    assert.equal((await call('POST', '/api/ports/check', {})).status, 400, 'the check needs a confirmation');
    assert.equal(((await call('POST', '/api/ports/check', { confirm: true })).json as { online: boolean }).online, true);
    assert.deepEqual((await call('POST', '/api/ports/upnp/close')).json, { closed: true });
    assert.equal(existsSync(join(net.dataDir, 'mcnetwork.json')), true);
  });
});
