/** Tiny DOM helper: h('div', {class: 'x', onClick: fn}, 'text', child, ...). */
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, kids);
  return el;
}

function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

/** Replaces the children of `el`; false/null are skipped and arrays are flattened (unlike el.replaceChildren). */
export function fill(el, ...kids) {
  clear(el);
  append(el, kids);
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

const SVG = 'http://www.w3.org/2000/svg';
export function svg(tag, attrs, ...kids) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  append(el, kids);
  return el;
}

/** 1536 -> "1.5 GB", 600 -> "600 MB" (input in MB). */
export function fmtMb(mb) {
  if (mb === null || mb === undefined || Number.isNaN(mb)) return '–';
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1).replace(/\.0$/, '')} GB` : `${Math.round(mb)} MB`;
}

export function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const hrs = Math.floor(m / 60);
  if (hrs < 48) return `${hrs}h ${m % 60}m`;
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}

export function fmtTime(ms, withSeconds = false) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: withSeconds ? '2-digit' : undefined });
}

/** Delays calls until `ms` of quiet. `.cancel()` drops a pending call (views call it when they are left). */
export const debounce = (fn, ms) => {
  let timer;
  const wrapped = (...a) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...a), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
};

/** Parses "2G" / "512M" into MB (0 if it does not parse). */
export function parseMb(text) {
  const m = /^(\d+)([MG])$/i.exec(text ?? '');
  return m ? Number(m[1]) * (m[2].toUpperCase() === 'G' ? 1024 : 1) : 0;
}

/** What a JVM with this heap occupies in RAM (mirrors the daemon's planner): heap + max(fixed, 15 %); fixed is 256 MB for a proxy and 512 MB for a game server. */
export const rssForHeap = (heapMb, role = 'backend') => heapMb + Math.max(role === 'proxy' ? 256 : 512, heapMb * 0.15);
