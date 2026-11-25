import { h } from './util.js';
import { t } from './i18n.js';

export function toast(message, kind = '') {
  let box = document.querySelector('.toasts');
  if (!box) {
    box = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(box);
  }
  const el = h('div', { class: `toast ${kind}` }, message);
  box.append(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 8000 : 4000);
}

/** Runs an async action; shows its error as a toast. Returns the result, or undefined on error. */
export async function attempt(work, success) {
  try {
    const result = await work();
    if (success) toast(success, 'good');
    return result;
  } catch (err) {
    toast(err.message, 'bad');
    return undefined;
  }
}

export function confirmDialog({ title, text, ok, danger = false }) {
  return new Promise((resolve) => {
    const dlg = h('dialog', {},
      h('h2', {}, title),
      h('p', { class: 'muted', style: 'margin:.6rem 0 1.2rem' }, text),
      h('div', { class: 'row', style: 'justify-content:flex-end' },
        h('button', { class: 'btn', onClick: () => dlg.close('cancel') }, t('Cancel')),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onClick: () => dlg.close('ok') }, ok),
      ),
    );
    dlg.addEventListener('close', () => {
      dlg.remove();
      resolve(dlg.returnValue === 'ok');
    });
    document.body.append(dlg);
    dlg.showModal();
  });
}

/** State of one server as label + icon + color: never color alone. */
export function stateInfo(view) {
  if (view.connection === 'failed') return { key: 'failed', label: t('Manager failed'), cls: 'bad', icon: '⚠' };
  if (view.connection === 'offline') return { key: 'offline', label: t('Manager offline'), cls: 'bad', icon: '⚠' };
  if (view.connection === 'connecting') return { key: 'connecting', label: t('Connecting'), cls: 'warn', icon: '◌' };
  switch (view.status?.state) {
    case 'running': return { key: 'running', label: t('Running'), cls: 'good', icon: '●' };
    case 'starting': return { key: 'starting', label: t('Starting'), cls: 'warn', icon: '◐' };
    case 'stopping': return { key: 'stopping', label: t('Stopping'), cls: 'warn', icon: '◑' };
    default: return { key: 'stopped', label: t('Stopped'), cls: '', icon: '■' };
  }
}

export const stateBadge = (view) => {
  const s = stateInfo(view);
  return h('span', { class: `badge ${s.cls}` }, h('span', { 'aria-hidden': 'true' }, s.icon), s.label);
};

export const pressureBadge = (level) => {
  const map = { ok: ['good', '●', t('Memory OK')], warn: ['warn', '▲', t('Memory tight')], critical: ['bad', '⚠', t('Memory critical')] };
  const [cls, icon, label] = map[level] ?? map.ok;
  return h('span', { class: `badge ${cls}` }, h('span', { 'aria-hidden': 'true' }, icon), label);
};

export const roleLabel = (cfg) => (cfg.role === 'proxy' ? t('Proxy') : t('Game server'));

/** Disables a button while its async handler runs. */
export function busyButton(label, handler, opts = {}) {
  const btn = h('button', { class: `btn ${opts.cls ?? ''}`, type: 'button', title: opts.title, disabled: opts.disabled }, label);
  btn.addEventListener('click', async () => {
    if (opts.confirm && !(await confirmDialog(opts.confirm))) return;
    btn.disabled = true;
    try {
      await handler();
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}
