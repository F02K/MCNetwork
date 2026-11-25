import { post } from '../api.js';
import { t } from '../i18n.js';
import { store } from '../store.js';
import { attempt, busyButton } from '../ui.js';
import { fmtDuration, fmtMb, h } from '../util.js';

/** TPS as a labelled badge: 20 is perfect, below 15 the game is visibly lagging. Icon and text, never color alone. */
export function tpsBadge(tps) {
  const [cls, icon] = tps >= 19 ? ['good', '●'] : tps >= 15 ? ['warn', '▲'] : ['bad', '⚠'];
  return h('span', { class: `badge ${cls}` }, h('span', { 'aria-hidden': 'true' }, icon), tps.toFixed(1));
}

const row = (label, value) => [h('dt', {}, label), h('dd', {}, value)];

/** The agent says it is not reporting: tell why in plain words. */
export function agentNotice(view) {
  const a = view.agent;
  if (!a.enabled) return t('The agent plugins are switched off in mcnetwork.json (agent.enabled).');
  if (a.error) return a.error;
  if (!a.connected) return view.status?.state === 'running' ? t('The agent plugin has not reported yet. It loads when the server starts; restart the server if it was running before the plugin was installed.') : t('The agent plugin reports as soon as the server runs.');
  return null;
}

function agentCard(view, rerender) {
  const a = view.agent;
  const id = view.config.id;
  const notice = agentNotice(view);
  const backends = store.order.map((i) => store.servers.get(i)).filter((v) => v.config.role === 'backend' && v.config.id !== id);
  const target = h('select', {}, backends.map((v) => h('option', { value: v.config.id, selected: v.config.entry }, v.config.name)));
  const last = a.commands[0];
  return h('div', { class: 'card stack' },
    h('h3', {}, t('Agent plugin')),
    h('dl', { class: 'kv' },
      ...row(t('Status'), a.connected ? t('reporting') : t('not reporting')),
      ...row(t('Version'), a.version ? `${a.version}${a.outdated ? ` (${t('update to {v} loads at the next restart', { v: a.bundledVersion })})` : ''}` : '–'),
    ),
    notice && h('div', { class: 'callout' }, h('span', { class: 'ico', 'aria-hidden': 'true' }, 'ℹ'), notice),
    h('div', { class: 'row' },
      busyButton(t('Free memory now'), async () => { await attempt(() => post(`/api/servers/${id}/gc`), t('Asked the server to free memory')); rerender(); }, { cls: 'small', disabled: !a.connected, title: t('Runs a garbage collection and reports the result') }),
      busyButton(t('Reinstall plugin'), async () => { await attempt(() => post(`/api/servers/${id}/agent/install`), t('Plugin files written. Restart the server to load them.')); rerender(); }, { cls: 'small', disabled: !a.enabled }),
    ),
    view.config.role === 'backend' && backends.length > 0 && h('div', { class: 'stack', style: 'gap:.5rem' },
      h('label', { class: 'field' }, t('Move players to'), target),
      busyButton(t('Move all players'), async () => { await attempt(() => post(`/api/servers/${id}/evacuate`, { to: target.value }), t('Players are being moved')); rerender(); }, { cls: 'small', disabled: !a.connected, title: t('Moves everybody to another server, for example before a restart'), style: 'align-self:flex-start' }),
    ),
    last && h('p', { class: 'muted small' }, `${last.type}: ${last.done ? `${last.ok ? '✓' : '✕'} ${last.message}` : t('waiting for the plugin…')}`),
  );
}

function jvmCard(jvm) {
  return h('div', { class: 'card stack' },
    h('h3', {}, t('Java memory')),
    h('dl', { class: 'kv' },
      ...row(t('Heap in use'), fmtMb(jvm.heapUsedMb)),
      ...row(t('Heap reserved'), fmtMb(jvm.heapCommittedMb)),
      ...row(t('Heap limit'), jvm.heapMaxMb ? fmtMb(jvm.heapMaxMb) : '–'),
      ...row(t('Still in use after cleanup'), jvm.liveSetMb ? fmtMb(jvm.liveSetMb) : '–'),
      ...row(t('Other memory (classes, native)'), fmtMb(jvm.nonHeapUsedMb)),
      ...row(t('Garbage collections'), `${jvm.gcCount} (${(jvm.gcTimeMs / 1000).toFixed(1)} s)`),
      ...row(t('Threads'), jvm.threads),
      ...row(t('CPU (of the machine)'), jvm.processCpu === null ? '–' : `${(jvm.processCpu * 100).toFixed(0)} %`),
      ...row(t('Uptime'), fmtDuration(jvm.uptimeMs)),
    ),
  );
}

function gameCard(game) {
  return h('div', { class: 'card stack' },
    h('h3', {}, t('Game performance')),
    h('dl', { class: 'kv' },
      ...row(t('TPS (1 / 5 / 15 min)'), h('span', { class: 'row', style: 'gap:.4rem;justify-content:flex-end;flex-wrap:nowrap' }, tpsBadge(game.tps[0]), h('span', { class: 'muted' }, game.tps.slice(1).map((v) => v.toFixed(1)).join(' · ')))),
      ...row(t('Time per tick (MSPT)'), game.mspt === null ? '–' : `${game.mspt.toFixed(1)} ms ${t('of 50 ms')}`),
      ...row(t('Players'), `${game.players} / ${game.maxPlayers}`),
      ...row(t('Minecraft'), game.version || '–'),
    ),
    game.worlds.length > 0 && h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, t('World')), h('th', { class: 'num' }, t('Chunks')), h('th', { class: 'num' }, t('Entities')), h('th', { class: 'num' }, t('Players')))),
      h('tbody', {}, game.worlds.map((w) => h('tr', {}, h('td', {}, w.name), h('td', { class: 'num' }, w.chunks), h('td', { class: 'num' }, w.entities), h('td', { class: 'num' }, w.players)))),
    )),
  );
}

function proxyCard(proxy) {
  return h('div', { class: 'card stack' },
    h('h3', {}, t('Players per server')),
    h('p', { class: 'muted small' }, `${proxy.players} ${t('players')} · ${proxy.version}`),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, t('Server')), h('th', { class: 'num' }, t('Players')))),
      h('tbody', {}, proxy.servers.map((s) => h('tr', {}, h('td', {}, s.name), h('td', { class: 'num' }, s.players)))),
    )),
  );
}

export function performanceTab(view, rerender) {
  const a = view.agent;
  return h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(390px,1fr))' },
    agentCard(view, rerender),
    a.connected && a.jvm && jvmCard(a.jvm),
    a.connected && a.game && gameCard(a.game),
    a.connected && a.proxy && proxyCard(a.proxy),
  );
}
