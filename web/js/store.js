import { eventsUrl, get } from './api.js';

/** Everything the views show. Views subscribe and re-render; the daemon is the source of truth. */
export const store = {
  /** id -> {config, connection, error, needsRestart, status} */
  servers: new Map(),
  order: [],
  ram: null,
  history: [],
  plan: null,
  setup: null,
  connected: false,
};

const listeners = new Set();
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function emit(kind, data) {
  for (const fn of [...listeners]) fn(kind, data);
}

const HISTORY_MAX = 600;

export function setServers(views) {
  store.servers = new Map(views.map((v) => [v.config.id, v]));
  store.order = views.map((v) => v.config.id);
  emit('servers');
}

/** Series color follows the server, not its rank in a sorted list. */
export const colorOf = (id) => `var(--s${(Math.max(0, store.order.indexOf(id)) % 8) + 1})`;

export async function refreshNetwork() {
  const net = await get('/api/network');
  store.ram = net.ram;
  store.plan = net.plan;
  setServers(net.servers);
  return net;
}

export async function loadHistory(minutes = 60) {
  store.history = await get(`/api/ram/history?minutes=${minutes}&points=${HISTORY_MAX}`);
  emit('ram');
}

let source = null;

export function connectEvents() {
  if (source) source.close();
  source = new EventSource(eventsUrl());
  source.addEventListener('open', () => {
    store.connected = true;
    emit('connection');
    refreshNetwork().catch(() => undefined);
  });
  source.addEventListener('error', () => {
    store.connected = false;
    emit('connection');
  });
  const on = (name, fn) => source.addEventListener(name, (e) => fn(JSON.parse(e.data)));
  on('status', ({ id, status }) => {
    const v = store.servers.get(id);
    if (!v) return;
    v.status = status;
    emit('status', id);
  });
  on('server', ({ id, event, data }) => {
    const v = store.servers.get(id);
    if (event === 'log') emit('log', { id, entry: data });
    else if (event === 'connection' && v) {
      v.connection = data.connection;
      emit('status', id);
    }
  });
  on('ram', (frame) => {
    store.ram = frame;
    store.history.push(frame);
    if (store.history.length > HISTORY_MAX) store.history.shift();
    emit('ram');
  });
  on('pressure', () => emit('ram'));
  on('servers', () => refreshNetwork().catch(() => undefined));
  on('setup', (state) => {
    store.setup = state;
    emit('setup');
  });
}
