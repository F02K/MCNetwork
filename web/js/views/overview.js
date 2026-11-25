import { post } from '../api.js';
import { usageBar } from '../charts.js';
import { t } from '../i18n.js';
import { store, subscribe } from '../store.js';
import { attempt, busyButton, pressureBadge, roleLabel, stateBadge, stateInfo, toast } from '../ui.js';
import { debounce, fill, fmtDuration, fmtMb, h, parseMb, rssForHeap } from '../util.js';

const act = (id, action, success) => attempt(() => post(`/api/servers/${id}/${action}`), success);

function serverCard(view) {
  const { config: cfg, status } = view;
  const s = stateInfo(view);
  const live = status && status.state !== 'stopped';
  const heapMb = status ? parseMb(status.memory.max) : 0;
  const rssMb = live ? status.memory.procRss / 1048576 : 0;
  const players = status?.players;
  const sw = status?.software;
  const problem = status?.problems?.[0];
  const online = view.connection === 'online';
  const confirmStop = (what) => ({ title: t('{what} "{name}"?', { what, name: cfg.name }), text: players?.count ? t('{n} player(s) are online and will be disconnected.', { n: players.count }) : t('The server saves its world and shuts down.'), ok: what, danger: true });

  return h('article', { class: 'card server-card' },
    h('div', { class: 'row' },
      h('div', { class: 'grow' },
        h('div', { class: 'role' }, roleLabel(cfg)),
        h('h3', {}, h('a', { href: `#/server/${cfg.id}` }, cfg.name)),
      ),
      stateBadge(view),
    ),
    h('dl', { class: 'kv' },
      h('dt', {}, t('Software')), h('dd', {}, sw ? `${sw.type}${sw.version ? ` ${sw.version}` : ''}` : t('not installed')),
      h('dt', {}, t('Port')), h('dd', {}, cfg.port ?? '–'),
      h('dt', {}, t('Players')), h('dd', {}, live && players ? `${players.count}${players.max ? ` / ${players.max}` : ''}` : '–'),
      h('dt', {}, t('Uptime')), h('dd', {}, live && status.uptimeMs ? fmtDuration(status.uptimeMs) : '–'),
    ),
    h('div', {},
      h('div', { class: 'row small', style: 'justify-content:space-between;margin-bottom:4px' },
        h('span', { class: 'muted' }, t('RAM')),
        h('span', {}, live ? `${fmtMb(rssMb)} ${t('of')} ${fmtMb(rssForHeap(heapMb, cfg.role))}` : `${t('heap limit')} ${fmtMb(heapMb)}`),
      ),
      usageBar(rssMb, rssForHeap(heapMb, cfg.role)),
    ),
    view.needsRestart && h('div', { class: 'callout info' }, h('span', { class: 'ico', 'aria-hidden': 'true' }, 'ℹ'), t('New RAM settings apply after a restart.')),
    view.error && !online && h('div', { class: 'callout bad' }, h('span', { class: 'ico', 'aria-hidden': 'true' }, '⚠'), view.error),
    problem && h('div', { class: 'callout' }, h('span', { class: 'ico', 'aria-hidden': 'true' }, '⚠'), h('span', {}, h('strong', {}, `${problem.title}. `), problem.advice)),
    h('div', { class: 'row', style: 'margin-top:auto' },
      s.key === 'stopped' || !online
        ? busyButton(t('Start'), () => act(cfg.id, 'start'), { cls: 'primary small', disabled: !online })
        : busyButton(t('Stop'), () => act(cfg.id, 'stop'), { cls: 'small', confirm: players?.count ? confirmStop(t('Stop')) : undefined }),
      busyButton(t('Restart'), () => act(cfg.id, 'restart'), { cls: 'small', disabled: !online || s.key === 'stopped', confirm: players?.count ? confirmStop(t('Restart')) : undefined }),
      h('a', { class: 'btn small right', href: `#/server/${cfg.id}` }, t('Open')),
    ),
  );
}

export function mount(root) {
  const render = () => {
    const views = store.order.map((id) => store.servers.get(id));
    if (!views.length) {
      fill(root, h('div', { class: 'card empty' },
        h('h2', {}, t('Let’s set up your network')),
        h('p', { class: 'muted', style: 'margin:.5rem auto 1.2rem;max-width:34rem' }, t('Pick a proxy, add your game servers and let MCNetwork install and connect them. RAM is planned for you.')),
        h('a', { class: 'btn primary', href: '#/setup' }, t('Start the setup')),
      ));
      return;
    }
    const running = views.filter((v) => v.status?.state === 'running').length;
    const players = views.reduce((n, v) => n + (v.status?.state === 'running' ? v.status.players.count : 0), 0);
    const frame = store.ram;
    const budget = store.plan?.budgetMb ?? 0;
    const used = frame?.networkRssMb ?? 0;
    fill(root, 
      h('div', { class: 'page-head' },
        h('h1', {}, t('Network')),
        h('div', { class: 'row right' },
          frame && pressureBadge(frame.pressure),
          busyButton(t('Start all'), async () => { for (const v of views.filter((x) => x.status?.state === 'stopped')) await act(v.config.id, 'start'); }, { cls: 'small' }),
          busyButton(t('Stop all'), async () => { for (const v of [...views].reverse().filter((x) => x.status && x.status.state !== 'stopped')) await act(v.config.id, 'stop'); toast(t('All servers stopped'), 'good'); },
            { cls: 'small', confirm: { title: t('Stop all servers?'), text: t('{n} player(s) are online.', { n: players }), ok: t('Stop all'), danger: true } }),
          h('a', { class: 'btn primary small', href: '#/setup' }, t('+ Add game server')),
        ),
      ),
      h('div', { class: 'grid stats', style: 'margin-bottom:16px' },
        h('div', { class: 'card stat' }, h('div', { class: 'label' }, t('Servers running')), h('div', { class: 'value' }, `${running} / ${views.length}`)),
        h('div', { class: 'card stat' }, h('div', { class: 'label' }, t('Players online')), h('div', { class: 'value' }, players)),
        h('div', { class: 'card stat' },
          h('div', { class: 'label' }, t('Network RAM')),
          h('div', { class: 'value' }, fmtMb(used)),
          h('div', { class: 'sub' }, budget ? `${t('of')} ${fmtMb(budget)} ${t('budget')}` : ''),
          budget ? usageBar(used, budget) : null,
        ),
        h('div', { class: 'card stat' },
          h('div', { class: 'label' }, t('Machine RAM available')),
          h('div', { class: 'value' }, frame ? fmtMb(frame.system.availableMb) : '–'),
          h('div', { class: 'sub' }, frame ? `${t('of')} ${fmtMb(frame.system.totalMb)}` : ''),
        ),
      ),
      h('div', { class: 'grid servers' }, views.map(serverCard)),
    );
  };
  render();
  const onChange = debounce((kind) => ['status', 'servers', 'ram'].includes(kind) && render(), 250);
  const unsub = subscribe(onChange);
  const tick = setInterval(render, 15_000); // keeps uptimes fresh
  return () => {
    unsub();
    onChange.cancel();
    clearInterval(tick);
  };
}
