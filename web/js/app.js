import { auth, get } from './api.js';
import { getLang, setLang, t } from './i18n.js';
import { connectEvents, loadHistory, refreshNetwork, store, subscribe } from './store.js';
import { clear, fill, h, svg } from './util.js';

const ROUTES = [
  { re: /^#\/server\/([^/]+)$/, load: () => import('./views/server.js'), params: (m) => ({ id: decodeURIComponent(m[1]) }), nav: '#/' },
  { re: /^#\/ram$/, load: () => import('./views/ram.js'), nav: '#/ram' },
  { re: /^#\/ports$/, load: () => import('./views/ports.js'), nav: '#/ports' },
  { re: /^#\/setup$/, load: () => import('./views/wizard.js'), nav: '#/setup' },
  { re: /^#?\/?$/, load: () => import('./views/overview.js'), nav: '#/' },
];

const THEME_KEY = 'mcnetwork.theme';
const app = document.getElementById('app');
let main;
let navEl;
let live;
let unmount = null;
let started = false;

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
try {
  applyTheme(localStorage.getItem(THEME_KEY));
} catch {
  /* storage blocked: follow the system theme */
}

function toggleTheme() {
  const dark = (document.documentElement.dataset.theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';
  const next = dark ? 'light' : 'dark';
  applyTheme(next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* storage blocked */
  }
}

const logo = () => svg('svg', { viewBox: '0 0 32 32', 'aria-hidden': 'true' },
  svg('rect', { width: 32, height: 32, rx: 7, fill: 'var(--accent)' }),
  svg('rect', { x: 6, y: 7, width: 8, height: 8, rx: 2, fill: 'var(--on-accent)' }),
  svg('rect', { x: 18, y: 7, width: 8, height: 8, rx: 2, fill: 'var(--on-accent)' }),
  svg('rect', { x: 12, y: 18, width: 8, height: 8, rx: 2, fill: 'var(--on-accent)' }),
);

function shell() {
  navEl = h('nav', { class: 'nav', 'aria-label': t('Main') }, [['#/', t('Network')], ['#/ram', t('RAM')], ['#/ports', t('Ports')], ['#/setup', t('Setup')]].map(([href, label]) => h('a', { href }, label)));
  live = h('span', { class: 'badge', title: t('Live connection to the daemon') });
  const lang = h('select', { 'aria-label': t('Language'), style: 'width:auto;min-height:32px;padding:.2rem .5rem', onChange: (e) => setLang(e.target.value) },
    [['en', 'English'], ['de', 'Deutsch']].map(([v, l]) => h('option', { value: v, selected: getLang() === v }, l)));
  main = h('main', { id: 'main' });
  fill(app, 
    h('header', { class: 'topbar' }, h('div', { class: 'topbar-inner' },
      h('a', { class: 'brand', href: '#/' }, logo(), 'MCNetwork'), navEl,
      h('div', { class: 'row right' }, live, lang, h('button', { class: 'btn ghost icon-btn', 'aria-label': t('Toggle light/dark'), title: t('Toggle light/dark'), onClick: toggleTheme }, svg('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' }, svg('circle', { cx: 12, cy: 12, r: 9, fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }), svg('path', { d: 'M12 3a9 9 0 0 1 0 18z', fill: 'currentColor' })))))),
    main,
  );
  paintLive();
}

function paintLive() {
  if (!live) return;
  const frame = store.ram;
  live.className = `badge ${store.connected ? 'good' : 'bad'}`;
  fill(live, h('span', { 'aria-hidden': 'true' }, store.connected ? '●' : '○'), store.connected ? t('Live') : t('Disconnected'));
  if (frame) live.title = frame.pressure;
}

let routeSeq = 0;

async function route() {
  if (!main) return;
  const seq = ++routeSeq; // a slower, older navigation must not draw over a newer one
  unmount?.();
  unmount = null;
  const hash = location.hash || '#/';
  const r = ROUTES.find((x) => x.re.test(hash)) ?? ROUTES[ROUTES.length - 1];
  for (const a of navEl.children) {
    if (a.getAttribute('href') === r.nav) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  const mod = await r.load();
  if (seq !== routeSeq) return;
  clear(main);
  unmount = mod.mount(main, r.params ? r.params(r.re.exec(hash)) : {});
  window.scrollTo(0, 0);
}

function login(message) {
  const input = h('input', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Token' });
  const go = async () => {
    auth.set(input.value.trim());
    started = false;
    await start();
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && void go());
  fill(app, h('main', {}, h('div', { class: 'card stack login' },
    h('div', { class: 'row' }, h('span', { style: 'width:28px;display:inline-flex' }, logo()), h('h1', {}, 'MCNetwork')),
    h('p', { class: 'muted' }, t('This daemon needs an access token (http.token in mcnetwork.json).')),
    message && h('div', { class: 'callout bad' }, message),
    h('label', { class: 'field' }, t('Access token'), input),
    h('button', { class: 'btn primary', onClick: () => void go() }, t('Sign in')),
  )));
  input.focus();
}

async function start() {
  if (started) return;
  started = true;
  try {
    await refreshNetwork();
    store.setup = await get('/api/setup');
  } catch (err) {
    started = false;
    if (err.status === 401) return login(auth.token ? t('That token was not accepted.') : '');
    fill(app, h('main', {}, h('div', { class: 'card empty' }, h('h2', {}, t('Cannot reach the daemon')), h('p', { class: 'muted' }, err.message), h('button', { class: 'btn', onClick: () => void start() }, t('Try again')))));
    return;
  }
  shell();
  connectEvents();
  loadHistory(60).catch(() => undefined);
  subscribe((kind) => {
    if (kind === 'connection' || kind === 'ram') paintLive();
  });
  await route();
}

window.addEventListener('hashchange', () => void route());
window.addEventListener('auth-required', () => {
  if (started) {
    started = false;
    login(t('That token was not accepted.'));
  }
});
window.addEventListener('languagechange-app', () => {
  started = false;
  void start();
});
void start();
