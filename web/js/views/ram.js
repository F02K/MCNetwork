import { get, post, put } from '../api.js';
import { framesTable, stackedAreaChart, usageBar } from '../charts.js';
import { t } from '../i18n.js';
import { colorOf, loadHistory, refreshNetwork, store, subscribe } from '../store.js';
import { attempt, busyButton, pressureBadge } from '../ui.js';
import { debounce, fill, fmtMb, h, parseMb } from '../util.js';

const RANGES = [[15, '15 min'], [60, '1 h'], [360, '6 h'], [1440, '24 h']];
const REASON = { share: () => t('by share'), pinned: () => t('fixed'), min: () => t('minimum'), max: () => t('maximum') };

export function mount(root) {
  let minutes = 60;
  let asTable = false;
  let plan = null;
  let peaks = {};
  let applied = null;
  const chartBox = h('div');
  const planBox = h('div');

  const series = () => store.order.map((id) => ({ id, name: store.servers.get(id)?.config.name ?? id, color: colorOf(id) }));

  const renderChart = () => {
    const frames = store.history;
    fill(chartBox, asTable ? framesTable({ frames, series: series() }) : stackedAreaChart({ frames, series: series(), budgetMb: plan?.budgetMb }));
  };

  const loadPlan = async () => {
    [plan, { peaks24h: peaks }] = await Promise.all([get('/api/ram/plan'), get('/api/ram')]);
    renderPlan();
  };

  const apply = async () => {
    applied = await attempt(() => post('/api/ram/plan/apply'));
    await refreshNetwork();
    await loadPlan();
  };

  const renderPlan = () => {
    if (!plan) return;
    const reserve = h('input', { type: 'number', min: 0, step: 128, value: plan.reserveMb, style: 'width:7.5rem', 'aria-label': t('Reserve for the system (MB)') });
    const rows = plan.allocations.map((a) => {
      const v = store.servers.get(a.id);
      const current = v?.status ? parseMb(v.status.memory.max) : 0;
      const differs = current && current !== a.xmxMb;
      return h('tr', {},
        h('td', {}, h('span', { class: 'swatch', style: `background:${colorOf(a.id)};margin-right:.5rem` }), v?.config.name ?? a.id),
        h('td', { class: 'num' }, v?.config.memory?.weight ?? (v?.config.role === 'proxy' ? 1 : 4)),
        h('td', { class: 'num' }, current ? fmtMb(current) : '–'),
        h('td', { class: 'num' }, h('strong', {}, fmtMb(a.xmxMb)), differs && h('span', { class: 'badge accent', style: 'margin-left:.4rem' }, '→')),
        h('td', { class: 'num' }, fmtMb(a.xmsMb)),
        h('td', { class: 'num' }, fmtMb(a.expectedRssMb)),
        h('td', { class: 'num' }, peaks[a.id] ? fmtMb(peaks[a.id]) : '–'),
        h('td', {}, h('span', { class: 'badge' }, REASON[a.reason]())),
      );
    });
    const restart = applied?.applied?.filter((a) => a.needsRestart) ?? [];
    fill(planBox, h('div', { class: 'card stack' },
      h('div', { class: 'card-head' },
        h('h2', {}, t('RAM plan')),
        h('span', { class: 'muted small' }, `${fmtMb(plan.totalMb)} ${t('machine')} − ${fmtMb(plan.reserveMb)} ${t('reserve')} = ${fmtMb(plan.budgetMb)} ${t('for Minecraft')}`),
        h('div', { class: 'row right' },
          h('label', { class: 'row small' }, t('Reserve'), reserve),
          busyButton(t('Save'), async () => { if (await attempt(() => put('/api/ram/config', { reserveMb: Number(reserve.value) }), t('Saved'))) await loadPlan(); }, { cls: 'small' }),
        ),
      ),
      plan.warnings.map((w) => h('div', { class: 'callout bad' }, h('span', { class: 'ico', 'aria-hidden': 'true' }, '⚠'), w)),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, t('Server')), h('th', { class: 'num' }, t('Share')), h('th', { class: 'num' }, t('Heap now')), h('th', { class: 'num' }, t('Heap planned')), h('th', { class: 'num' }, t('Start heap')), h('th', { class: 'num' }, t('Expected RAM')), h('th', { class: 'num' }, t('Peak 24 h')), h('th', {}, t('Why')))),
        h('tbody', {}, rows),
      )),
      h('div', {}, h('div', { class: 'row small', style: 'justify-content:space-between;margin-bottom:4px' }, h('span', { class: 'muted' }, t('Planned total')), h('span', {}, `${fmtMb(plan.expectedRssMb)} ${t('of')} ${fmtMb(plan.budgetMb)}`)), usageBar(plan.expectedRssMb, plan.budgetMb, { neutral: true })),
      h('p', { class: 'muted small' }, t('A running server keeps its heap until it restarts. “Expected RAM” is the heap plus the JVM’s own overhead.')),
      h('div', { class: 'row' }, busyButton(t('Apply plan'), apply, { cls: 'primary' }), applied && !restart.length && h('span', { class: 'muted small' }, t('Applied. Nothing needs a restart.'))),
      restart.length > 0 && h('div', { class: 'callout info' }, h('span', { class: 'ico', 'aria-hidden': 'true' }, 'ℹ'),
        h('div', { class: 'stack', style: 'gap:.5rem' }, h('span', {}, t('These servers run with an older heap. Restart them when it suits you:')),
          h('div', { class: 'row' }, restart.map((a) => busyButton(`${t('Restart')} ${store.servers.get(a.id)?.config.name ?? a.id}`, () => attempt(() => post(`/api/servers/${a.id}/restart`), t('Restarting')), { cls: 'small' }))))),
    ));
  };

  const head = () => h('div', { class: 'page-head' },
    h('h1', {}, t('RAM')),
    store.ram && pressureBadge(store.ram.pressure),
    h('div', { class: 'row right' },
      h('div', { class: 'seg', role: 'group', 'aria-label': t('Time range') }, RANGES.map(([m, label]) => h('button', { 'aria-pressed': String(minutes === m), onClick: async () => { minutes = m; await loadHistory(m); paint(); } }, label))),
      h('div', { class: 'seg', role: 'group', 'aria-label': t('View') }, [[false, t('Chart')], [true, t('Table')]].map(([v, label]) => h('button', { 'aria-pressed': String(asTable === v), onClick: () => { asTable = v; paint(); } }, label))),
    ),
  );

  const paint = () => {
    fill(root, head(), h('div', { class: 'card', style: 'margin-bottom:16px' }, h('h2', { style: 'margin-bottom:8px' }, t('RAM per server')), chartBox), planBox);
    renderChart();
    renderPlan();
  };

  paint();
  loadHistory(minutes).then(renderChart, () => undefined);
  loadPlan().catch(() => undefined);
  const onChange = debounce((kind) => kind === 'ram' && renderChart(), 400);
  const unsub = subscribe(onChange);
  const refresh = setInterval(() => void loadPlan().catch(() => undefined), 30_000);
  return () => {
    unsub();
    onChange.cancel();
    clearInterval(refresh);
  };
}
