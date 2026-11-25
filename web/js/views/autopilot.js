import { get, post, put } from '../api.js';
import { t } from '../i18n.js';
import { store, subscribe } from '../store.js';
import { attempt, busyButton, toast } from '../ui.js';
import { debounce, fill, fmtTime, h } from '../util.js';

const ACTIONS = {
  'free-memory': () => t('Free memory'),
  'stop-idle': () => t('Stop empty server'),
  wake: () => t('Start on demand'),
  ready: () => t('Ready'),
  'restart-leak': () => t('Restart (memory leak)'),
  evacuate: () => t('Move players'),
  blocked: () => t('Held back'),
};

function resultBadge(e) {
  if (e.dryRun) return h('span', { class: 'badge accent', title: t('Dry run: nothing was done') }, h('span', { 'aria-hidden': 'true' }, '◌'), t('Simulated'));
  if (e.ok === true) return h('span', { class: 'badge good' }, h('span', { 'aria-hidden': 'true' }, '✓'), t('Done'));
  if (e.ok === false) return h('span', { class: 'badge bad', title: e.error }, h('span', { 'aria-hidden': 'true' }, '✕'), t('Failed'));
  return h('span', { class: 'badge' }, h('span', { 'aria-hidden': 'true' }, 'ℹ'), t('Note'));
}

export function mount(root) {
  let state = null;
  const box = h('div', { class: 'stack' });

  const load = async () => {
    state = await get('/api/autopilot');
    paint();
  };

  const check = (checked, onChange) => h('input', { type: 'checkbox', checked, onChange: (e) => onChange(e.target.checked) });

  const paint = () => {
    if (!state) return;
    const cfg = { ...state.config };
    const idle = h('input', { type: 'number', min: 1, value: cfg.idleMinutes, style: 'width:6rem', onInput: (e) => (cfg.idleMinutes = Number(e.target.value)) });
    const save = async () => {
      if (await attempt(() => put('/api/autopilot', cfg), t('Saved'))) await load();
    };
    const rule = (title, text, key, ...extra) => h('div', { class: 'card stack', style: 'gap:.5rem' },
      h('label', { class: 'check' }, check(cfg[key], (v) => (cfg[key] = v)), h('span', {}, h('strong', {}, title), h('div', { class: 'muted small' }, text))),
      ...extra);
    fill(box,
      h('div', { class: 'card stack' },
        h('label', { class: 'check' }, check(cfg.enabled, (v) => (cfg.enabled = v)), h('span', {}, h('strong', {}, t('Autopilot')), h('div', { class: 'muted small' }, t('Does routine things by itself. It never touches a server with players on it, and never the join-first server or the proxy.')))),
        h('label', { class: 'check' }, check(cfg.dryRun, (v) => (cfg.dryRun = v)), h('span', {}, h('strong', {}, t('Dry run (recommended at first)')), h('div', { class: 'muted small' }, t('Only writes down what it would do. Watch the log below for a while, then switch this off.')))),
        cfg.enabled && !cfg.dryRun && h('div', { class: 'callout' }, h('span', { class: 'ico', 'aria-hidden': 'true' }, '⚠'), t('Dry run is off: the rules below really stop and restart servers.')),
      ),
      rule(t('Free memory when the machine gets tight'), t('Asks every server to run a garbage collection (needs the plugins). Harmless and quick.'), 'gcOnPressure'),
      rule(t('Stop servers that nobody is on'), t('A server that has been empty for the time below is stopped to give its memory back. When memory is tight it happens sooner.'), 'stopIdle',
        h('div', { class: 'row', style: 'margin-left:1.9rem' }, h('label', { class: 'row small' }, t('Empty for (minutes)'), idle)),
        h('label', { class: 'check', style: 'margin-left:1.9rem' }, check(cfg.wakeOnDemand, (v) => (cfg.wakeOnDemand = v)), h('span', {}, t('Start it again when a player wants to join'), h('div', { class: 'muted small' }, t('The proxy holds the player, the server starts, and the player is connected as soon as it is ready. Needs the proxy plugin 0.2.0 or newer.')))),
        cfg.stopIdle && cfg.wakeOnDemand && !state.wakeSupported && h('div', { class: 'callout' }, h('span', { class: 'ico', 'aria-hidden': 'true' }, 'ℹ'), t('The proxy plugin does not report yet (or is older than 0.2.0). Restart the proxy once after updating; until then no server is stopped.'))),
      rule(t('Restart a server whose memory need keeps growing'), t('If the memory a server really needs grows steadily for hours and is nearly at the limit (a typical memory leak), it is restarted when nobody is on it. Players are moved to another server first when it is critical.'), 'restartOnLeak'),
      h('div', {}, busyButton(t('Save'), save, { cls: 'primary' })),
      state.sleeping.length > 0 && h('div', { class: 'card stack' }, h('h2', {}, t('Sleeping servers')),
        state.sleeping.map((s) => h('div', { class: 'row' }, h('span', { class: 'grow' }, `${store.servers.get(s.name)?.config.name ?? s.name} · ${t('since')} ${fmtTime(s.since)}`),
          busyButton(t('Start now'), async () => { await attempt(() => post('/api/autopilot/wake', { server: s.name }), t('Starting')); await load(); }, { cls: 'small' })))),
      h('div', { class: 'card stack' }, h('h2', {}, t('What it did')),
        state.events.length === 0 ? h('p', { class: 'muted' }, t('Nothing yet.')) : h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, t('Time')), h('th', {}, t('Server')), h('th', {}, t('Action')), h('th', {}, t('Why')), h('th', {}, t('Result')))),
          h('tbody', {}, state.events.slice(0, 60).map((e) => h('tr', {}, h('td', {}, fmtTime(e.t, true)), h('td', {}, e.server ? (store.servers.get(e.server)?.config.name ?? e.server) : '–'), h('td', {}, (ACTIONS[e.action] ?? (() => e.action))()), h('td', {}, e.reason, e.error ? h('div', { class: 'small muted' }, e.error) : null), h('td', {}, resultBadge(e)))))))),
    );
  };

  fill(root, h('div', { class: 'page-head' }, h('h1', {}, t('Autopilot'))), box);
  load().catch((err) => toast(err.message, 'bad'));
  const onChange = debounce((kind) => { if (kind === 'autopilot') void load().catch(() => undefined); }, 300);
  const unsub = subscribe(onChange);
  return () => { unsub(); onChange.cancel(); };
}
