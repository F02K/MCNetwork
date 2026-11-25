import { get, post, put, del } from '../api.js';
import { t } from '../i18n.js';
import { refreshNetwork, store, subscribe } from '../store.js';
import { attempt, busyButton, roleLabel, stateBadge, stateInfo, toast } from '../ui.js';
import { performanceTab } from './performance.js';
import { debounce, fill, fmtDuration, fmtMb, fmtTime, h, parseMb } from '../util.js';

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g'); // terminal color codes
const MAX_LINES = 1500;

function logLine(entry) {
  const text = entry.text.replace(ANSI, '');
  const cls = entry.src === 'mcli' ? 'l-mcli' : /\b(ERROR|SEVERE|Exception)\b/.test(text) ? 'l-err' : /\bWARN/.test(text) ? 'l-warn' : '';
  return h('div', { class: cls }, text);
}

function consoleTab(id) {
  const box = h('div', { class: 'console', tabindex: 0, role: 'log', 'aria-label': t('Server console') });
  const input = h('input', { type: 'text', placeholder: t('Type a command, e.g. list'), autocomplete: 'off', 'aria-label': t('Command') });
  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    const ok = await attempt(() => post(`/api/servers/${id}/command`, { text }));
    if (ok === false) toast(t('The server is not running.'), 'bad');
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && void send());
  const add = (entry) => {
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.append(logLine(entry));
    while (box.childElementCount > MAX_LINES) box.firstChild.remove();
    if (stick) box.scrollTop = box.scrollHeight;
  };
  get(`/api/servers/${id}/logs?limit=400`).then((entries) => {
    entries.forEach(add);
    box.scrollTop = box.scrollHeight;
  }, () => undefined);
  const unsub = subscribe((kind, data) => kind === 'log' && data.id === id && add(data.entry));
  const el = h('div', {}, box, h('div', { class: 'console-in' }, input, h('button', { class: 'btn primary', onClick: () => void send() }, t('Send'))));
  return { el, destroy: unsub };
}

function playersTab(view) {
  const players = view.status?.players;
  if (!players?.online.length) return h('p', { class: 'muted' }, view.status?.state === 'running' ? t('Nobody is online.') : t('The server is not running.'));
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, t('Player')), h('th', {}, t('Online since')))),
    h('tbody', {}, players.online.map((p) => h('tr', {}, h('td', {}, p.name), h('td', {}, fmtTime(p.since, true))))),
  ));
}

function settingsTab(view, rerender) {
  const cfg = view.config;
  const mem = cfg.memory ?? {};
  const field = (label, hint, input) => h('label', { class: 'field' }, label, input, hint && h('span', { class: 'hint' }, hint));
  const name = h('input', { type: 'text', value: cfg.name });
  const num = (v) => h('input', { type: 'number', min: 0, step: 'any', value: v ?? '', placeholder: t('automatic') });
  const weight = num(mem.weight);
  const minMb = num(mem.minMb);
  const maxMb = num(mem.maxMb);
  const pinned = num(mem.pinnedMb);
  const auto = h('input', { type: 'checkbox', checked: cfg.autoStart });
  const entry = h('input', { type: 'checkbox', checked: !!cfg.entry, disabled: cfg.role !== 'backend' });
  const val = (el) => (el.value === '' ? undefined : Number(el.value));
  const save = async () => {
    const memory = Object.fromEntries(Object.entries({ weight: val(weight), minMb: val(minMb), maxMb: val(maxMb), pinnedMb: val(pinned) }).filter(([, v]) => v !== undefined));
    const done = await attempt(() => put(`/api/servers/${cfg.id}`, { name: name.value.trim() || cfg.id, autoStart: auto.checked, entry: entry.checked, memory }), t('Saved'));
    if (done) {
      await refreshNetwork();
      if (await attempt(() => post('/api/ram/plan/apply'))) toast(t('RAM plan updated. Restart the server to use the new heap.'));
      rerender();
    }
  };
  const status = view.status;
  return h('div', { class: 'stack' },
    h('div', { class: 'card stack' },
      h('h3', {}, t('General')),
      field(t('Display name'), null, name),
      h('label', { class: 'check' }, auto, h('span', {}, t('Start with the network'))),
      cfg.role === 'backend' && h('label', { class: 'check' }, entry, h('span', {}, t('Players join this server first'), h('div', { class: 'muted small' }, t('The first stop after login and the fallback when a server shuts down.')))),
    ),
    h('div', { class: 'card stack' },
      h('h3', {}, t('RAM')),
      h('p', { class: 'muted small' }, t('Currently configured heap: {min} start, {max} maximum. The share below decides how much of the network’s RAM budget this server gets; leave fields empty for the default.', { min: status ? fmtMb(parseMb(status.memory.min)) : '–', max: status ? fmtMb(parseMb(status.memory.max)) : '–' })),
      h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(170px,1fr))' },
        field(t('Share (weight)'), t('Default: proxy 1, game server 4'), weight),
        field(t('Minimum heap (MB)'), null, minMb),
        field(t('Maximum heap (MB)'), null, maxMb),
        field(t('Fixed heap (MB)'), t('Ignores the share'), pinned),
      ),
    ),
    h('div', { class: 'row' }, busyButton(t('Save'), save, { cls: 'primary' }),
      busyButton(t('Remove from network'), async () => { if (await attempt(() => del(`/api/servers/${cfg.id}`), t('Removed (files stay on disk)'))) location.hash = '#/'; },
        { cls: 'danger right', disabled: status?.state !== 'stopped', title: status?.state !== 'stopped' ? t('Stop the server first') : '',
          confirm: { title: t('Remove "{name}"?', { name: cfg.name }), text: t('The server leaves the network. Its folder and world stay on disk.'), ok: t('Remove'), danger: true } })),
  );
}

function softwareCard(view) {
  const { status } = view;
  const sw = status?.software;
  const up = status?.updates;
  return h('div', { class: 'card stack' },
    h('h3', {}, t('Software')),
    h('dl', { class: 'kv' },
      h('dt', {}, t('Installed')), h('dd', {}, sw ? `${sw.type} ${sw.version ?? ''}${sw.build ? ` (build ${sw.build})` : ''}` : t('nothing')),
      h('dt', {}, t('Java')), h('dd', { class: 'mono' }, status?.java ?? '–'),
      h('dt', {}, t('Update')), h('dd', {}, up?.error ? up.error : up?.sameMc ? up.sameMc : t('up to date')),
    ),
    up?.sameMc && busyButton(t('Update now'), () => attempt(() => post(`/api/servers/${view.config.id}/update`), t('Updated')), { cls: 'primary small', disabled: status.state !== 'stopped', title: status.state !== 'stopped' ? t('Stop the server first') : '' }),
  );
}

export function mount(root, { id }) {
  let tab = 'console';
  let tabCleanup = null;
  const body = h('div');
  const head = h('div');
  const view = () => store.servers.get(id);

  const renderTab = () => {
    tabCleanup?.();
    tabCleanup = null;
    const v = view();
    if (!v) return;
    if (tab === 'console') {
      const c = consoleTab(id);
      tabCleanup = c.destroy;
      fill(body, c.el);
    } else if (tab === 'performance') fill(body, performanceTab(v, renderTab));
    else if (tab === 'players') fill(body, playersTab(v));
    else fill(body, h('div', { class: 'stack' }, settingsTab(v, renderTab), softwareCard(v)));
  };

  const renderHead = () => {
    const v = view();
    if (!v) return fill(head, h('div', { class: 'card empty' }, h('h2', {}, t('Server not found')), h('a', { href: '#/' }, t('Back to the network'))));
    const s = stateInfo(v);
    const online = v.connection === 'online';
    const st = v.status;
    fill(head, 
      h('div', { class: 'page-head' },
        h('a', { class: 'btn ghost icon-btn', href: '#/', 'aria-label': t('Back') }, '←'),
        h('div', {}, h('div', { class: 'role' }, roleLabel(v.config)), h('h1', {}, v.config.name)),
        stateBadge(v),
        st?.state === 'running' && h('span', { class: 'muted small' }, `${t('Uptime')} ${fmtDuration(st.uptimeMs)} · ${st.players.count} ${t('players')}`),
        h('div', { class: 'row right' },
          s.key === 'stopped' || !online ? busyButton(t('Start'), () => attempt(() => post(`/api/servers/${id}/start`)), { cls: 'primary', disabled: !online }) : busyButton(t('Stop'), () => attempt(() => post(`/api/servers/${id}/stop`)), { confirm: st?.players.count ? { title: t('Stop "{name}"?', { name: v.config.name }), text: t('{n} player(s) are online and will be disconnected.', { n: st.players.count }), ok: t('Stop'), danger: true } : undefined }),
          busyButton(t('Restart'), () => attempt(() => post(`/api/servers/${id}/restart`)), { disabled: !online || s.key === 'stopped' }),
          busyButton(t('Backup'), () => attempt(() => post(`/api/servers/${id}/backup`), t('Backup created')), { disabled: !online }),
        ),
      ),
      v.needsRestart && h('div', { class: 'callout info', style: 'margin-bottom:16px' }, h('span', { class: 'ico', 'aria-hidden': 'true' }, 'ℹ'), t('New RAM settings apply after a restart.')),
      st?.problems?.map((p) => h('div', { class: 'callout', style: 'margin-bottom:12px' }, h('span', { class: 'ico', 'aria-hidden': 'true' }, '⚠'), h('span', {}, h('strong', {}, `${p.title}. `), p.advice))),
    );
  };

  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const renderTabs = () => {
    fill(tabs, ...[['console', t('Console')], ['performance', t('Performance')], ['players', t('Players')], ['settings', t('Settings')]].map(([key, label]) =>
      h('button', { role: 'tab', 'aria-selected': String(tab === key), onClick: () => { tab = key; renderTabs(); renderTab(); } }, label)));
  };
  fill(root, head, tabs, body);
  renderHead();
  renderTabs();
  renderTab();
  const onChange = debounce((kind) => {
    if (kind === 'status' || kind === 'servers') {
      renderHead();
      if (tab === 'players' || tab === 'performance') renderTab();
    }
  }, 250);
  const unsub = subscribe(onChange);
  return () => {
    unsub();
    onChange.cancel();
    tabCleanup?.();
  };
}
