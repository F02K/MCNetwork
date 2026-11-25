import { get, post } from '../api.js';
import { t } from '../i18n.js';
import { store, subscribe } from '../store.js';
import { attempt, busyButton, toast } from '../ui.js';
import { debounce, fill, h } from '../util.js';

const copy = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    toast(t('Copied'), 'good');
  } catch {
    toast(text); // no clipboard access (plain http): show the text so it can be selected
  }
};

function codeBlock(lines) {
  return h('div', { class: 'stack', style: 'gap:.4rem' }, lines.map((l) => h('div', { class: 'row', style: 'flex-wrap:nowrap' },
    h('code', { class: 'grow', style: 'background:var(--surface-2);padding:.4rem .6rem;border-radius:6px;overflow-wrap:anywhere' }, l),
    h('button', { class: 'btn small', onClick: () => void copy(l) }, t('Copy')))));
}

function stepCard(n, ok, title, ...body) {
  return h('div', { class: 'card stack', style: 'gap:.6rem' },
    h('div', { class: 'row' }, h('span', { class: `badge ${ok === true ? 'good' : ok === false ? 'warn' : ''}` }, h('span', { 'aria-hidden': 'true' }, ok === true ? '✓' : ok === false ? '!' : '·'), n), h('h3', {}, title)),
    ...body);
}

export function mount(root) {
  let overview = null;
  let access = null;
  let editing = null;
  let router = null;
  let check = null;
  const tableBox = h('div');
  const accessBox = h('div', { class: 'stack' });

  const load = async () => {
    [overview, access] = await Promise.all([get('/api/ports'), get('/api/ports/access')]);
    paintTable();
    paintAccess();
  };

  const savePort = async (row, input) => {
    const port = Number(input.value);
    const view = await attempt(() => post(`/api/servers/${row.id}/port`, { port }));
    if (view) {
      toast(row.role === 'proxy' ? t('Port changed. Players now connect to port {p}; the router and firewall need the new port too.', { p: port }) : t('Port changed. The server uses it from its next start.'), 'good');
      editing = null;
      await load();
    }
  };

  const paintTable = () => {
    if (!overview) return;
    const rows = overview.rows.flatMap((r) => {
      const view = store.servers.get(r.id);
      const running = view?.status && view.status.state !== 'stopped';
      const input = h('input', { type: 'number', min: 1, max: 65535, value: r.port ?? '', style: 'width:7rem', 'aria-label': t('New port') });
      const main = h('tr', {},
        h('td', {}, r.name, h('div', { class: 'role' }, r.role === 'proxy' ? t('Proxy') : r.standalone ? t('managed only') : t('Game server'))),
        h('td', { class: 'num' }, editing === r.id ? input : h('strong', {}, r.port ?? '–')),
        h('td', {}, r.exposure === 'local'
          ? h('span', { class: 'badge good' }, h('span', { 'aria-hidden': 'true' }, '●'), t('Only this machine'))
          : h('span', { class: `badge ${r.role === 'proxy' ? 'accent' : 'warn'}` }, h('span', { 'aria-hidden': 'true' }, r.role === 'proxy' ? '●' : '▲'), t('Everyone that can reach this machine'))),
        h('td', {}, r.listening ? h('span', { class: 'badge good' }, h('span', { 'aria-hidden': 'true' }, '●'), t('Listening')) : h('span', { class: 'badge' }, h('span', { 'aria-hidden': 'true' }, '○'), t('Not running'))),
        h('td', {}, editing === r.id
          ? h('span', { class: 'row', style: 'gap:.4rem' }, busyButton(t('Save'), () => savePort(r, input), { cls: 'small primary' }), h('button', { class: 'btn small', onClick: () => { editing = null; paintTable(); } }, t('Cancel')))
          : h('button', { class: 'btn small', disabled: running, title: running ? t('Stop the server first') : '', onClick: () => { editing = r.id; paintTable(); } }, t('Change port'))),
      );
      const issues = r.issues.length ? [h('tr', {}, h('td', { colspan: 5, style: 'padding-top:0' }, r.issues.map((i) => h('div', { class: 'callout' }, h('span', { class: 'ico', 'aria-hidden': 'true' }, '⚠'), i)),
        r.canMakeLocal && busyButton(t('Make it listen on this machine only'), async () => { if (await attempt(() => post(`/api/servers/${r.id}/port`, { localOnly: true }), t('Done. It takes effect at the next start of the server.'))) await load(); }, { cls: 'small', disabled: running, title: running ? t('Stop the server first') : '' })))] : [];
      return [main, ...issues];
    });
    fill(tableBox, h('div', { class: 'card stack' },
      h('div', {}, h('h2', {}, t('Ports in your network')), h('p', { class: 'muted small' }, t('Game servers listen on this machine only; players reach them through the proxy. Only the proxy port has to be open to the internet.'))),
      h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, t('Server')), h('th', { class: 'num' }, t('Port')), h('th', {}, t('Reachable from')), h('th', {}, t('Status')), h('th', {}))), h('tbody', {}, rows)))));
  };

  const paintAccess = () => {
    if (!access) return;
    const a = access;
    if (a.proxyPort === null) return fill(accessBox, h('div', { class: 'card muted' }, t('There is no proxy yet, so there is nothing to open. Run the setup first.')));
    const m = a.upnp.mapping;
    const fw = a.firewall;
    fill(accessBox,
      h('div', {}, h('h2', {}, t('Let players in from the internet')), h('p', { class: 'muted small' }, t('Four steps. Skip what you do not need: on a server in a data center the router step does not exist; at home the firewall step often does not.'))),
      a.address && h('div', { class: 'callout info' }, h('span', { class: 'ico', 'aria-hidden': 'true' }, 'ℹ'), h('span', {}, t('Players connect to'), ' ', h('strong', { class: 'mono' }, a.address))),
      stepCard('1', a.proxyRunning, t('The proxy runs on port {p}', { p: a.proxyPort }),
        a.proxyRunning ? h('p', { class: 'muted small' }, t('It answers on this machine.')) : h('p', { class: 'muted' }, t('Start the proxy first (Network page).'))),
      stepCard('2', fw?.portOpen === true || fw?.active === false ? true : !fw?.commands.length ? null : false, t('Firewall of this machine'),
        fw?.tool ? h('p', { class: 'muted small' }, `${t('Found')}: ${fw.tool}${fw.active === true ? ` (${t('active')})` : fw.active === false ? ` (${t('off')})` : ''}`) : null,
        fw?.note && h('p', { class: 'muted small' }, fw.note),
        fw?.commands.length > 0 && fw.active !== false && fw.portOpen !== true && h('div', { class: 'stack', style: 'gap:.4rem' }, h('p', { class: 'small' }, fw.platform === 'win32' ? t('Run one of these in an elevated PowerShell (MCNetwork does not change your firewall by itself):') : t('Run this as administrator (MCNetwork does not change your firewall by itself):')), codeBlock(fw.commands))),
      stepCard('3', m ? true : null, t('Router: forward the port'),
        a.carrierNat && h('div', { class: 'callout bad' }, h('span', { class: 'ico', 'aria-hidden': 'true' }, '⚠'), t('Your router reports a private address. Your internet provider probably shares one address between customers (CGNAT): forwarding a port cannot work. Ask the provider for a public address or use a tunnel service.')),
        m
          ? h('div', { class: 'stack', style: 'gap:.5rem' }, h('p', {}, t('Port {p} is forwarded by {r} to {c}. MCNetwork keeps it open while it runs and gives it back when it stops.', { p: m.port, r: m.router, c: m.internalClient })),
            busyButton(t('Close the port'), async () => { await attempt(() => post('/api/ports/upnp/close'), t('Port closed')); await load(); }, { cls: 'small' }))
          : h('div', { class: 'stack', style: 'gap:.6rem' },
            h('div', { class: 'row' },
              busyButton(t('Find my router'), async () => { router = await attempt(() => post('/api/ports/upnp/discover')); paintAccess(); }, { cls: 'small' }),
              router?.found && busyButton(t('Open port {p} automatically', { p: a.proxyPort }), async () => { if (await attempt(() => post('/api/ports/upnp/open'), t('Port opened'))) await load(); }, { cls: 'small primary' })),
            router?.found && h('p', { class: 'muted small' }, `${t('Found')}: ${router.router}${router.externalIp ? ` · ${t('public address')} ${router.externalIp}` : ''}`),
            router && !router.found && h('div', { class: 'callout' }, h('span', { class: 'ico', 'aria-hidden': 'true' }, 'ℹ'), t('No router answered. UPnP may be off in the router, or it does not support it. Forward the port by hand:')),
            h('p', { class: 'small muted' }, t('By hand: in your router\'s settings ("port forwarding" or "virtual servers") forward TCP port {p} to this machine:', { p: a.proxyPort })),
            a.lan.length > 0 ? codeBlock(a.lan.map((l) => `${l.address}  (${l.name})`)) : h('p', { class: 'muted small' }, t('No network address found.')))),
      stepCard('4', check ? check.online : null, t('Check from the internet'),
        h('p', { class: 'muted small' }, t('Asks a public Minecraft status service (mcsrvstat.us) to connect from outside. This sends your public address and the port to that service, so it only happens when you click.')),
        busyButton(t('Check now'), async () => { check = await attempt(() => post('/api/ports/check', { confirm: true })); paintAccess(); }, { cls: 'small' }),
        check && (check.online
          ? h('div', { class: 'callout info' }, h('span', { class: 'ico', 'aria-hidden': 'true' }, '✓'), t('Reachable: {ip}:{port} answered{v}', { ip: check.ip, port: check.port, v: check.version ? ` (${check.version})` : '' }))
          : h('div', { class: 'callout bad' }, h('span', { class: 'ico', 'aria-hidden': 'true' }, '⚠'), h('div', { class: 'stack', style: 'gap:.3rem' }, h('strong', {}, t('Not reachable from the internet ({ip}:{port})', { ip: check.ip, port: check.port })), h('ul', { style: 'margin:0;padding-left:1.1rem' }, check.hints.map((x) => h('li', {}, x))))))),
    );
  };

  fill(root, h('div', { class: 'page-head' }, h('h1', {}, t('Ports'))), tableBox, h('div', { style: 'height:24px' }), accessBox);
  load().catch((err) => toast(err.message, 'bad'));
  const onChange = debounce((kind) => { if (kind === 'status' && !editing) void load().catch(() => undefined); }, 1000);
  const unsub = subscribe(onChange);
  return () => { unsub(); onChange.cancel(); };
}
