import { t } from './i18n.js';
import { fill, fmtMb, fmtTime, h, svg } from './util.js';

const W = 900;
const H = 300;
const M = { l: 56, r: 14, t: 14, b: 28 };

const GB_STEPS = [1, 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96, 128, 192, 256, 384, 512, 768, 1024];

/** Rounds an axis maximum (MB) up to a round value whose quarters are round too (4 GB, 12 GB, 20 GB, ...). */
export function niceMax(mb) {
  if (mb <= 2048) return [256, 512, 1024, 1536, 2048].find((v) => v >= mb) ?? 2048;
  const gb = mb / 1024;
  return (GB_STEPS.find((v) => v >= gb) ?? Math.ceil(gb / 256) * 256) * 1024;
}

/**
 * Stacked area chart of RAM per server over time.
 * opts: {frames, series: [{id, name, color}], budgetMb, rangeMs}
 * Hover (or touch) shows a crosshair and a tooltip with every series at that moment.
 */
export function stackedAreaChart({ frames, series, budgetMb }) {
  const wrap = h('div', { class: 'chart chart-wrap' });
  if (frames.length < 2) {
    wrap.append(h('p', { class: 'muted', style: 'padding:3rem 0;text-align:center' }, t('Collecting data… the chart appears after a few samples.')));
    return wrap;
  }
  const values = frames.map((f) => series.map((s) => f.servers[s.id]?.rssMb ?? 0));
  const totals = values.map((v) => v.reduce((a, b) => a + b, 0));
  const t0 = frames[0].t;
  const t1 = frames[frames.length - 1].t;
  const yMax = niceMax(Math.max(...totals, budgetMb ?? 0) * 1.06);
  const x = (time) => M.l + ((time - t0) / Math.max(1, t1 - t0)) * (W - M.l - M.r);
  const y = (mb) => H - M.b - (mb / yMax) * (H - M.t - M.b);

  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': t('RAM per server over time') });
  for (let i = 0; i <= 4; i++) {
    const mb = (yMax / 4) * i;
    root.append(svg('line', { class: i === 0 ? 'axis' : 'grid-line', x1: M.l, x2: W - M.r, y1: y(mb), y2: y(mb) }));
    root.append(svg('text', { x: M.l - 8, y: y(mb) + 4, 'text-anchor': 'end' }, fmtMb(mb)));
  }
  for (let i = 0; i <= 4; i++) {
    const time = t0 + ((t1 - t0) / 4) * i;
    root.append(svg('text', { x: x(time), y: H - 8, 'text-anchor': i === 0 ? 'start' : i === 4 ? 'end' : 'middle' }, fmtTime(time, t1 - t0 < 20 * 60_000)));
  }

  // Without data (the daemon was off) the chart stays empty instead of sloping to zero: frames far apart start a new segment.
  const gaps = frames.slice(1).map((f, i) => f.t - frames[i].t).sort((a, b) => a - b);
  const gapMs = Math.max(30_000, 4 * (gaps[Math.floor(gaps.length / 2)] ?? 0));
  const segments = [];
  frames.forEach((f, i) => {
    if (i === 0 || f.t - frames[i - 1].t > gapMs) segments.push([]);
    segments[segments.length - 1].push(i);
  });

  // stacked areas, bottom series first; a thin surface-colored outline leaves a gap between fills
  const base = frames.map(() => 0);
  series.forEach((s, si) => {
    const top = frames.map((f, i) => base[i] + values[i][si]);
    for (const seg of segments) {
      if (seg.length < 2) continue;
      const up = seg.map((i) => `${x(frames[i].t).toFixed(1)},${y(top[i]).toFixed(1)}`);
      const down = seg.map((i) => `${x(frames[i].t).toFixed(1)},${y(base[i]).toFixed(1)}`).reverse();
      root.append(svg('path', { class: 'area', d: `M${up.join('L')}L${down.join('L')}Z`, fill: s.color, 'fill-opacity': 0.88 }));
    }
    top.forEach((v, i) => (base[i] = v));
  });

  if (budgetMb) {
    root.append(svg('line', { class: 'budget', x1: M.l, x2: W - M.r, y1: y(budgetMb), y2: y(budgetMb) }));
    root.append(svg('text', { x: W - M.r - 4, y: y(budgetMb) - 6, 'text-anchor': 'end', style: 'fill:var(--text);font-weight:600' }, `${t('Budget')} ${fmtMb(budgetMb)}`));
  }

  const cross = svg('line', { class: 'crosshair', y1: M.t, y2: H - M.b, style: 'display:none' });
  const tip = h('div', { class: 'tooltip', style: 'display:none', role: 'status' });
  const hit = svg('rect', { x: M.l, y: M.t, width: W - M.l - M.r, height: H - M.t - M.b, fill: 'transparent', style: 'touch-action:pan-y' });
  root.append(cross, hit);
  wrap.append(root, tip);

  const show = (evt) => {
    const box = root.getBoundingClientRect();
    const px = ((evt.clientX - box.left) / box.width) * W;
    const time = t0 + ((px - M.l) / (W - M.l - M.r)) * (t1 - t0);
    let best = 0;
    for (let i = 1; i < frames.length; i++) if (Math.abs(frames[i].t - time) < Math.abs(frames[best].t - time)) best = i;
    const f = frames[best];
    if (Math.abs(f.t - time) > gapMs / 2) return hide(); // in a gap there is nothing to show
    cross.setAttribute('x1', x(f.t));
    cross.setAttribute('x2', x(f.t));
    cross.style.display = '';
    fill(tip, 
      h('div', { class: 't-head' }, fmtTime(f.t, true)),
      ...series.map((s, si) => h('div', { class: 't-row' }, h('span', {}, h('span', { class: 'swatch', style: `background:${s.color}` }), s.name), h('strong', {}, fmtMb(values[best][si])))),
      h('div', { class: 't-row', style: 'border-top:1px solid var(--border);margin-top:4px;padding-top:4px' }, h('span', {}, t('Network total')), h('strong', {}, fmtMb(totals[best]))),
      h('div', { class: 't-row muted' }, h('span', {}, t('System available')), h('span', {}, fmtMb(f.system.availableMb))),
    );
    tip.style.display = '';
    const wrapBox = wrap.getBoundingClientRect();
    const left = Math.min(Math.max(0, evt.clientX - wrapBox.left + 14), wrapBox.width - tip.offsetWidth);
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(0, evt.clientY - wrapBox.top - tip.offsetHeight - 10)}px`;
  };
  const hide = () => {
    cross.style.display = 'none';
    tip.style.display = 'none';
  };
  hit.addEventListener('pointermove', show);
  hit.addEventListener('pointerdown', show);
  hit.addEventListener('pointerleave', hide);

  wrap.append(h('div', { class: 'legend' }, series.map((s) => h('span', {}, h('span', { class: 'swatch', style: `background:${s.color}` }), s.name))));
  return wrap;
}

/** The same data as a table (for screen readers and for exact numbers). */
export function framesTable({ frames, series }) {
  const rows = frames.filter((_, i) => i % Math.max(1, Math.ceil(frames.length / 40)) === 0).reverse();
  return h('div', { class: 'table-wrap' },
    h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, t('Time')), series.map((s) => h('th', { class: 'num' }, s.name)), h('th', { class: 'num' }, t('Total')), h('th', { class: 'num' }, t('System available')))),
      h('tbody', {}, rows.map((f) => h('tr', {}, h('td', {}, fmtTime(f.t, true)), series.map((s) => h('td', { class: 'num' }, fmtMb(f.servers[s.id]?.rssMb ?? 0))), h('td', { class: 'num' }, fmtMb(f.networkRssMb)), h('td', { class: 'num' }, fmtMb(f.system.availableMb))))),
    ),
  );
}

/** Horizontal usage bar; turns amber/red when nearly full (with the percentage as text, so color is not alone). */
export function usageBar(used, max, { neutral = false } = {}) {
  const pct = max > 0 ? Math.min(100, (used / max) * 100) : 0;
  const cls = neutral ? '' : pct > 92 ? 'bad' : pct > 80 ? 'warn' : '';
  return h('div', { class: `bar ${cls}`, role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(pct) }, h('span', { style: `width:${pct.toFixed(1)}%` }));
}
