import { get, post } from '../api.js';
import { t } from '../i18n.js';
import { refreshNetwork, store, subscribe } from '../store.js';
import { toast } from '../ui.js';
import { fill, fmtMb, h } from '../util.js';
import { usageBar } from '../charts.js';

const SIZES = { small: 2, medium: 4, large: 8 };
const TEMPLATES = [
  { id: 'lobby', name: 'Lobby', size: 'small' },
  { id: 'survival', name: 'Survival', size: 'large' },
  { id: 'creative', name: 'Creative', size: 'medium' },
  { id: 'minigames', name: 'Minigames', size: 'medium' },
];
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** The answers survive leaving the page; they are cleared when a setup has finished. */
const fresh = () => ({ step: 0, proxy: { version: '', port: 25565, motd: 'A Minecraft Network' }, servers: [], reserveMb: 0, acceptEula: false, start: true });
let wiz = fresh();
let defaults = null;

const field = (label, input, hint) => h('label', { class: 'field' }, label, input, hint && h('span', { class: 'hint' }, hint));

function versionSelect(choices, current, onChange) {
  const sel = h('select', { onChange: () => onChange(sel.value) }, choices.versions.map((v) => h('option', { value: v, selected: v === (current || choices.default) }, v === choices.default ? `${v} (${t('recommended')})` : v)));
  return sel;
}

function proxyStep() {
  return h('div', { class: 'stack' },
    h('div', {}, h('h2', {}, t('Choose your proxy')), h('p', { class: 'muted' }, t('The proxy is the front door of your network: players connect to it and it sends them to your game servers.'))),
    h('button', { class: 'choice', role: 'radio', 'aria-checked': 'true' }, h('div', {}, h('strong', {}, 'Velocity'), ' ', h('span', { class: 'badge good' }, t('recommended')), h('p', { class: 'muted small' }, t('Modern, fast and actively developed. Secure player forwarding to Paper servers is set up for you.')))),
    h('button', { class: 'choice', role: 'radio', 'aria-checked': 'false', 'aria-disabled': 'true', title: t('Not available yet') }, h('div', {}, h('strong', {}, 'BungeeCord / Waterfall'), ' ', h('span', { class: 'badge' }, t('later')), h('p', { class: 'muted small' }, t('Older proxies. Velocity is the better choice for new networks.')))),
    h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(200px,1fr))' },
      field(t('Velocity version'), versionSelect(defaults.velocity, wiz.proxy.version, (v) => (wiz.proxy.version = v)), t('The newest recommended build is preselected.')),
      field(t('Public port'), h('input', { type: 'number', min: 1, max: 65535, value: wiz.proxy.port, onInput: (e) => (wiz.proxy.port = Number(e.target.value)) }), t('Players connect here. 25565 is the Minecraft default.')),
    ),
    field(t('Server list message (MOTD)'), h('input', { type: 'text', value: wiz.proxy.motd, onInput: (e) => (wiz.proxy.motd = e.target.value) }), t('Shown in the player’s server list. MiniMessage formatting like <green>text</green> works.')),
  );
}

function serversStep(rerender, hasProxy) {
  const taken = () => new Set([...wiz.servers.map((s) => s.id), ...store.order]);
  const add = (tpl) => {
    let id = tpl.id;
    let name = tpl.name;
    for (let i = 2; taken().has(id); i++) {
      id = `${tpl.id}${i}`;
      name = `${tpl.name} ${i}`;
    }
    wiz.servers.push({ id, name, version: '', size: tpl.size, entry: false });
    if (!wiz.servers.some((s) => s.entry) && !(hasProxy && [...store.servers.values()].some((v) => v.config.entry))) wiz.servers[0].entry = true;
    rerender();
  };
  const rows = wiz.servers.map((s, i) => h('div', { class: 'server-row' },
    field(t('ID'), h('input', { type: 'text', value: s.id, maxlength: 32, title: t('Used in the proxy and folder'), onInput: (e) => (s.id = e.target.value.trim().toLowerCase()) })),
    field(t('Name'), h('input', { type: 'text', value: s.name, onInput: (e) => (s.name = e.target.value) })),
    field('Paper', versionSelect(defaults.paper, s.version, (v) => (s.version = v))),
    field(t('Size'), h('select', { onChange: (e) => (s.size = e.target.value) }, [['small', t('Small – lobby, hub')], ['medium', t('Medium')], ['large', t('Large – survival, big worlds')]].map(([v, l]) => h('option', { value: v, selected: s.size === v }, l)))),
    h('div', { class: 'row' },
      h('label', { class: 'check small', title: t('Players join this server first') }, h('input', { type: 'radio', name: 'entry', checked: s.entry, onChange: () => { wiz.servers.forEach((x) => (x.entry = x === s)); } }), t('Join first')),
      h('button', { class: 'btn ghost icon-btn', 'aria-label': t('Remove'), onClick: () => { wiz.servers.splice(i, 1); if (!wiz.servers.some((x) => x.entry) && wiz.servers[0]) wiz.servers[0].entry = true; rerender(); } }, '✕'),
    ),
  ));
  return h('div', { class: 'stack' },
    h('div', {}, h('h2', {}, t('Your game servers')), h('p', { class: 'muted' }, t('Each one is a Paper server. Players pick them with /server or join the first one automatically. You can add more at any time.'))),
    rows.length ? rows : h('p', { class: 'muted' }, t('Add at least one game server.')),
    h('div', { class: 'row' }, h('span', { class: 'muted small' }, t('Add:')), TEMPLATES.map((tpl) => h('button', { class: 'btn small', onClick: () => add(tpl) }, `+ ${tpl.name}`)),
      h('button', { class: 'btn small', onClick: () => add({ id: 'server', name: 'Server', size: 'medium' }) }, `+ ${t('Other')}`)),
  );
}

function previewBody(hasProxy) {
  const existing = [...store.servers.values()].map((v) => ({ id: v.config.id, role: v.config.role, memory: v.config.memory }));
  return [...(hasProxy ? [] : [{ id: 'proxy', role: 'proxy' }]), ...existing, ...wiz.servers.map((s) => ({ id: s.id || 'x', role: 'backend', memory: { weight: SIZES[s.size] } }))];
}

function ramStep(hasProxy) {
  const out = h('div', { class: 'stack' });
  const reserve = h('input', { type: 'number', min: 0, step: 128, value: wiz.reserveMb || '', placeholder: t('automatic'), style: 'width:9rem' });
  const load = async () => {
    wiz.reserveMb = Number(reserve.value) || 0;
    let plan;
    try {
      plan = await post('/api/ram/plan/preview', { servers: previewBody(hasProxy), reserveMb: wiz.reserveMb });
    } catch (err) {
      return fill(out, h('div', { class: 'callout bad' }, err.message));
    }
    const name = (id) => store.servers.get(id)?.config.name ?? wiz.servers.find((s) => s.id === id)?.name ?? (id === 'proxy' ? 'Velocity' : id);
    fill(out, 
      plan.warnings.map((w) => h('div', { class: 'callout bad' }, h('span', { class: 'ico', 'aria-hidden': 'true' }, '⚠'), w)),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, t('Server')), h('th', { class: 'num' }, t('Heap (max)')), h('th', { class: 'num' }, t('Start heap')), h('th', { class: 'num' }, t('Expected RAM')))),
        h('tbody', {}, plan.allocations.map((a) => h('tr', {}, h('td', {}, name(a.id)), h('td', { class: 'num' }, h('strong', {}, fmtMb(a.xmxMb))), h('td', { class: 'num' }, fmtMb(a.xmsMb)), h('td', { class: 'num' }, fmtMb(a.expectedRssMb))))),
      )),
      h('div', {}, h('div', { class: 'row small', style: 'justify-content:space-between;margin-bottom:4px' }, h('span', { class: 'muted' }, t('Total')), h('span', {}, `${fmtMb(plan.expectedRssMb)} ${t('of')} ${fmtMb(plan.budgetMb)}`)), usageBar(plan.expectedRssMb, plan.budgetMb, { neutral: true })),
    );
  };
  reserve.addEventListener('change', load);
  load();
  return h('div', { class: 'stack' },
    h('div', {}, h('h2', {}, t('RAM')), h('p', { class: 'muted' }, t('This machine has {total} of RAM. MCNetwork keeps some for the system and shares the rest between your servers by size. You can change this later.', { total: fmtMb(defaults.ram.totalMb) }))),
    field(t('Reserve for the system (MB)'), reserve, t('Leave empty for automatic ({n}).', { n: fmtMb(defaults.ram.reserveMb) })),
    out,
  );
}

function reviewStep(hasProxy) {
  const eula = h('input', { type: 'checkbox', checked: wiz.acceptEula, onChange: () => { wiz.acceptEula = eula.checked; go.disabled = !eula.checked; } });
  const go = h('button', { class: 'btn primary', disabled: !wiz.acceptEula, onClick: async () => {
    go.disabled = true;
    try {
      const body = { backends: wiz.servers.map((s) => ({ id: s.id, name: s.name, version: s.version || undefined, memory: { weight: SIZES[s.size] }, entry: s.entry })), acceptEula: wiz.acceptEula, start: wiz.start };
      if (!hasProxy) {
        body.proxy = { version: wiz.proxy.version || undefined, port: wiz.proxy.port, motd: wiz.proxy.motd };
        body.ram = { reserveMb: wiz.reserveMb };
      }
      store.setup = await post('/api/setup', body);
      wiz.step = 'install';
      location.hash = '#/setup';
      window.dispatchEvent(new Event('wizard-rerender'));
    } catch (err) {
      toast(err.message, 'bad');
      go.disabled = false;
    }
  } }, t('Create the network'));
  go.id = 'create-btn';
  return h('div', { class: 'stack' },
    h('div', {}, h('h2', {}, t('Review')), h('p', { class: 'muted' }, t('This is what MCNetwork will do:'))),
    h('ul', { style: 'margin:0;padding-left:1.2rem;display:flex;flex-direction:column;gap:.35rem' },
      !hasProxy && h('li', {}, t('Install Velocity {v} on port {p}', { v: wiz.proxy.version || defaults.velocity.default, p: wiz.proxy.port })),
      wiz.servers.map((s) => h('li', {}, t('Install Paper {v} as "{n}" ({size})', { v: s.version || defaults.paper.default, n: s.name, size: s.size === 'small' ? t('small') : s.size === 'large' ? t('large') : t('medium') }))),
      h('li', {}, t('Connect everything: secure player forwarding, server list, local-only game server ports')),
      h('li', {}, t('Plan the RAM and set the heap of every server')),
    ),
    h('label', { class: 'check card' }, eula, h('span', {}, t('I accept the '), h('a', { href: 'https://aka.ms/MinecraftEULA', target: '_blank', rel: 'noopener noreferrer' }, t('Minecraft EULA')), t(' for the game servers.'), h('div', { class: 'muted small' }, t('Required: Paper servers will not start without it. MCNetwork never accepts it for you.')))),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: wiz.start, onChange: (e) => (wiz.start = e.target.checked) }), h('span', {}, t('Start the network when the setup is done'))),
    h('div', {}, go),
  );
}

const ICON = { pending: '○', running: '◐', done: '✓', failed: '✕' };

function installStep(finish) {
  const box = h('div', { class: 'stack' });
  const paint = () => {
    const s = store.setup;
    if (!s) return fill(box, h('p', { class: 'muted' }, t('No setup is running.')), h('a', { class: 'btn', href: '#/' }, t('Back to the network')));
    fill(box, 
      h('div', {}, h('h2', {}, s.status === 'done' ? t('Your network is ready') : s.status === 'failed' ? t('The setup stopped') : t('Setting up your network…')), h('p', { class: 'muted' }, s.status === 'running' ? t('Downloads and first starts take a few minutes. You can leave this page; the setup keeps running.') : '')),
      h('div', { class: 'progress-list' }, s.steps.map((st) => h('div', { class: `progress-item ${st.status}` },
        h('span', { class: `ic ${st.status === 'running' ? 'spin' : ''}`, 'aria-hidden': 'true' }, ICON[st.status]),
        h('div', { class: 'grow' }, h('span', {}, st.label), st.detail && h('div', { class: `small ${st.status === 'failed' ? '' : 'muted'}` }, st.detail)),
        h('span', { class: 'sr-only' }, st.status)))),
      s.error && h('div', { class: 'callout bad' }, h('span', { class: 'ico', 'aria-hidden': 'true' }, '⚠'), h('span', {}, h('strong', {}, `${s.error} `), t('The servers created so far stay in your network. Fix the problem, remove broken servers in the dashboard and add them again.'))),
      s.status !== 'running' && h('div', {}, h('a', { class: 'btn primary', href: '#/', onClick: finish }, t('Open the dashboard'))),
    );
  };
  paint();
  const poll = setInterval(async () => {
    try {
      const s = await get('/api/setup');
      if (s) store.setup = s;
      paint();
    } catch { /* the event stream keeps the view current when polling fails */ }
  }, 2500);
  const unsub = subscribe((kind) => kind === 'setup' && paint());
  box.cleanup = () => { clearInterval(poll); unsub(); };
  return box;
}

export function mount(root) {
  const hasProxy = [...store.servers.values()].some((v) => v.config.role === 'proxy');
  const steps = hasProxy ? ['servers', 'ram', 'review'] : ['proxy', 'servers', 'ram', 'review'];
  const labels = { proxy: t('Proxy'), servers: t('Game servers'), ram: t('RAM'), review: t('Review') };
  let cleanup = null;
  let loading = true;

  const validate = (key) => {
    if (key === 'proxy' && !(wiz.proxy.port >= 1 && wiz.proxy.port <= 65535)) return t('Enter a port between 1 and 65535.');
    if (key === 'servers') {
      if (!wiz.servers.length) return t('Add at least one game server.');
      const ids = new Set();
      for (const s of wiz.servers) {
        if (!ID_RE.test(s.id)) return t('"{id}" is not a valid ID: use 1-32 lowercase letters, digits, "-" or "_".', { id: s.id });
        if (ids.has(s.id) || store.servers.has(s.id) || s.id === 'proxy') return t('The ID "{id}" is used twice.', { id: s.id });
        ids.add(s.id);
      }
    }
    return null;
  };

  const render = () => {
    cleanup?.();
    cleanup = null;
    if (store.setup?.status === 'running') wiz.step = 'install';
    if (wiz.step === 'install') {
      const el = installStep(() => { if (store.setup?.status === 'done') wiz = fresh(); refreshNetwork().catch(() => undefined); });
      cleanup = el.cleanup;
      return fill(root, h('div', { class: 'wizard' }, el));
    }
    const key = steps[Math.min(wiz.step, steps.length - 1)];
    const idx = steps.indexOf(key);
    const error = h('p', { class: 'callout bad', style: 'display:none' });
    const content = loading ? h('p', { class: 'muted' }, t('Loading…')) : { proxy: proxyStep, servers: () => serversStep(render, hasProxy), ram: () => ramStep(hasProxy), review: () => reviewStep(hasProxy) }[key]();
    fill(root, h('div', { class: 'wizard' },
      h('ol', { class: 'steps', style: 'padding:0;margin:0 0 20px' }, steps.map((k, i) => h('li', { class: i < idx ? 'done' : '', 'aria-current': i === idx ? 'step' : undefined }, labels[k]))),
      h('div', { class: 'card stack' }, content, error,
        key !== 'review' && h('div', { class: 'row', style: 'justify-content:space-between;margin-top:8px' },
          h('button', { class: 'btn', disabled: idx === 0, onClick: () => { wiz.step = idx - 1; render(); } }, t('Back')),
          h('button', { class: 'btn primary', disabled: loading, onClick: () => {
            const problem = validate(key);
            if (problem) { error.textContent = problem; error.style.display = ''; return; }
            wiz.step = idx + 1;
            render();
          } }, t('Next'))),
        key === 'review' && h('div', {}, h('button', { class: 'btn', onClick: () => { wiz.step = idx - 1; render(); } }, t('Back'))),
      ),
    ));
  };

  const loadDefaults = async () => {
    try {
      defaults = await get('/api/setup/defaults');
      if (!wiz.servers.length) wiz.servers = [{ id: 'lobby', name: 'Lobby', version: '', size: 'small', entry: !hasProxy || ![...store.servers.values()].some((v) => v.config.entry) }, ...(hasProxy ? [] : [{ id: 'survival', name: 'Survival', version: '', size: 'large', entry: false }])];
      loading = false;
      render();
    } catch (err) {
      fill(root, h('div', { class: 'wizard' }, h('div', { class: 'card stack' }, h('h2', {}, t('The setup cannot start yet')), h('div', { class: 'callout bad' }, err.message), h('p', { class: 'muted' }, t('MCNetwork needs MCLI to look up versions. Check that "mcliPath" in mcnetwork.json points to mcli.js.')))));
    }
  };
  const rerender = () => render();
  window.addEventListener('wizard-rerender', rerender);
  if (defaults) loading = false;
  render();
  if (!defaults) loadDefaults();
  return () => {
    window.removeEventListener('wizard-rerender', rerender);
    cleanup?.();
  };
}
