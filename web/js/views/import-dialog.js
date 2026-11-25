import { post } from '../api.js';
import { t } from '../i18n.js';
import { fmtMb, h } from '../util.js';

const MODES = [
  ['copy', () => t('Copy (recommended)'), () => t('Works on a copy. Your original folder stays exactly as it is.')],
  ['move', () => t('Move'), () => t('Takes the folder over. Fast for big worlds, but the original place is empty afterwards.')],
  ['link', () => t('Use where it is'), () => t('No files are moved. MCNetwork changes the server in its current folder; the changed files are saved first.')],
];

const SUPPORT_TEXT = {
  full: () => t('Paper server: it joins the network as it is.'),
  convert: () => t('Spigot server: it can be switched to Paper (your world and plugins stay), or just be managed.'),
  standalone: () => t('This software cannot receive players from the proxy without extra mods. MCNetwork can still start, stop, back up and monitor it.'),
  proxy: () => t('Velocity proxy'),
  none: () => t('No Minecraft server found here.'),
};

/**
 * Asks for the folder of an existing server, shows what MCNetwork found and how it will be brought in.
 * `role` is 'backend' (game server) or 'proxy' (Velocity); `onAdd(entry)` gets {id, name, import, summary}.
 */
export function openImportDialog({ role, takenIds, onAdd }) {
  let report = null;
  const path = h('input', { type: 'text', placeholder: '/home/me/minecraft/survival', 'aria-label': t('Folder of the server') });
  const result = h('div', { class: 'stack', style: 'gap:.75rem' });
  const dlg = h('dialog', { style: 'width:min(560px,calc(100vw - 32px))' },
    h('h2', {}, role === 'proxy' ? t('Use an existing Velocity proxy') : t('Import an existing server')),
    h('p', { class: 'muted small', style: 'margin:.4rem 0 1rem' }, t('Enter the full path of the server folder on this machine. Nothing is changed until you start the setup.')),
    h('div', { class: 'row', style: 'flex-wrap:nowrap' }, path, h('button', { class: 'btn primary', onClick: () => void check() }, t('Check'))),
    result,
  );
  path.addEventListener('keydown', (e) => e.key === 'Enter' && void check());

  const close = () => dlg.close();

  async function check() {
    result.replaceChildren(h('p', { class: 'muted' }, t('Looking…')));
    try {
      report = await post('/api/import/inspect', { path: path.value.trim() });
    } catch (err) {
      result.replaceChildren(h('div', { class: 'callout bad' }, err.message));
      return;
    }
    renderReport();
  }

  function renderReport() {
    const r = report;
    const wrongRole = (role === 'proxy') !== (r.support === 'proxy');
    const issues = [...r.issues];
    if (!issues.length && wrongRole && r.support !== 'none') issues.push(role === 'proxy' ? t('This is not a Velocity proxy.') : t('This is a Velocity proxy. Use it in the proxy step of the setup.'));
    const facts = [
      r.software && [t('Software'), `${r.software.type}${r.software.version ? ` ${r.software.version}` : ''}`],
      r.properties?.port && [t('Port now'), r.properties.port],
      r.worlds.length > 0 && [t('Worlds'), r.worlds.join(', ')],
      r.plugins.length > 0 && [t('Plugins'), `${r.plugins.length}`],
      r.sizeBytes > 0 && [t('Size'), fmtMb(r.sizeBytes / 1048576)],
    ].filter(Boolean);
    const state = { mode: 'copy', convert: r.support === 'convert', version: '', id: r.suggestedId, name: r.suggestedId };
    const idIn = h('input', { type: 'text', value: state.id, maxlength: 32, onInput: (e) => (state.id = e.target.value.trim().toLowerCase()) });
    const nameIn = h('input', { type: 'text', value: state.name, onInput: (e) => (state.name = e.target.value) });
    const error = h('p', { class: 'callout bad', style: 'display:none' });
    const modes = MODES.map(([value, label, hint]) => h('label', { class: 'check' }, h('input', { type: 'radio', name: 'import-mode', checked: value === 'copy', onChange: () => (state.mode = value) }), h('span', {}, label(), h('div', { class: 'muted small' }, hint()))));
    const convertBox = h('input', { type: 'checkbox', checked: state.convert, onChange: (e) => (state.convert = e.target.checked) });
    const versionIn = h('input', { type: 'text', placeholder: '1.21.8', onInput: (e) => (state.version = e.target.value.trim()) });
    const add = () => {
      if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(state.id)) return show(t('"{id}" is not a valid ID: use 1-32 lowercase letters, digits, "-" or "_".', { id: state.id }));
      if (takenIds().includes(state.id)) return show(t('The ID "{id}" is used twice.', { id: state.id }));
      const spec = { path: r.dir, mode: state.mode };
      if (r.support === 'convert' && state.convert) {
        spec.convertToPaper = true;
        if (!r.software.version && !state.version) return show(t('Enter the Minecraft version to switch to Paper.'));
        if (state.version) spec.version = state.version;
      } else if (r.support === 'convert') spec.standalone = true;
      const standalone = spec.standalone === true || r.support === 'standalone';
      onAdd({ id: state.id, name: state.name || state.id, import: spec, summary: `${r.software.type}${r.software.version ? ` ${r.software.version}` : ''}`, standalone, warnings: r.warnings });
      close();
    };
    const show = (m) => {
      error.textContent = m;
      error.style.display = '';
    };
    result.replaceChildren(
      h('dl', { class: 'kv' }, facts.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
      h('p', {}, (SUPPORT_TEXT[r.support] ?? SUPPORT_TEXT.none)()),
      issues.map((i) => h('div', { class: 'callout bad' }, h('span', { class: 'ico', 'aria-hidden': 'true' }, '⚠'), i)),
      !issues.length && r.warnings.map((w) => h('div', { class: 'callout' }, h('span', { class: 'ico', 'aria-hidden': 'true' }, 'ℹ'), w)),
      !issues.length && h('div', { class: 'stack', style: 'gap:.75rem' },
        r.support === 'convert' && h('label', { class: 'check' }, convertBox, h('span', {}, t('Switch to Paper'), h('div', { class: 'muted small' }, t('The Spigot jar is replaced by Paper of the same Minecraft version. A backup of the world is made first.')))),
        r.support === 'convert' && !r.software.version && h('label', { class: 'field' }, t('Minecraft version'), versionIn),
        role === 'backend' && h('div', { class: 'grid', style: 'grid-template-columns:1fr 1fr' }, h('label', { class: 'field' }, t('ID'), idIn), h('label', { class: 'field' }, t('Name'), nameIn)),
        h('fieldset', { style: 'border:0;padding:0;margin:0' }, h('legend', { class: 'small', style: 'font-weight:600;margin-bottom:.4rem' }, t('How should the files be brought in?')), h('div', { class: 'stack', style: 'gap:.5rem' }, modes)),
        error,
        h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { class: 'btn', onClick: close }, t('Cancel')), h('button', { class: 'btn primary', onClick: add }, role === 'proxy' ? t('Use this proxy') : t('Add to the setup'))),
      ),
    );
  }

  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  path.focus();
}
