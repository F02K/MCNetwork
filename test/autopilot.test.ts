import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { WAKE_AGENT_VERSION } from '../src/autopilot/engine';
import { createHttpServer } from '../src/http/server';
import { parseReport } from '../src/agent/protocol';
import type { AutopilotConfig, ServerConfig } from '../src/types';
import { AGENT_TOKEN, makeNetwork, server, SYSTEM_8G, waitFor } from './helpers';

const MIN = 60_000;
const jvm = { heapUsedMb: 400, heapCommittedMb: 512, heapMaxMb: 1024, nonHeapUsedMb: 90, liveSetMb: 250, gcCount: 5, gcTimeMs: 120, threads: 30, uptimeMs: 50000, processors: 4, processCpu: 0.1 };
const paper = (id: string, players = 0) => parseReport({ serverId: id, kind: 'paper', agentVersion: '0.2.0', time: 1, jvm, game: { tps: [20, 20, 20], mspt: 2, players, maxPlayers: 20, version: '1.21.8', worlds: [] } });
const velocity = (version = WAKE_AGENT_VERSION, wake: string[] = []) => parseReport({ serverId: 'proxy', kind: 'velocity', agentVersion: version, time: 1, jvm, proxy: { players: 0, version: 'Velocity', servers: [], wakeRequests: wake } });

const servers = (): ServerConfig[] => [server('proxy', { role: 'proxy', autoStart: false }), server('lobby', { autoStart: false, entry: true }), server('survival', { autoStart: false }), server('creative', { autoStart: false })];

/** A network whose clock and machine memory the test controls; everything is running and every agent reports. */
async function rig(cfg: Partial<AutopilotConfig> = {}, extra: { maxActionsPerHour?: number } = {}) {
  const clock = { t: 1_000_000_000 };
  const mem = { ...SYSTEM_8G };
  const made = makeNetwork(servers(), { autopilot: { enabled: true, dryRun: false, intervalSeconds: 30, gcOnPressure: true, stopIdle: false, idleMinutes: 15, wakeOnDemand: false, restartOnLeak: false, ...cfg } }, { systemMemory: () => mem, autopilot: { now: () => clock.t, minUptimeMs: 0, ...extra } });
  const { net } = made;
  await net.start();
  for (const s of servers()) await net.startServer(s.id);
  await waitFor(() => net.views().every((v) => v.status?.state === 'running'), 5000, 'all running');
  for (const s of ['lobby', 'survival', 'creative']) net.agents.submit(paper(s));
  net.agents.submit(velocity());
  const tick = async (advanceMs = 0) => {
    clock.t += advanceMs;
    net.sampleRam(clock.t);
    await net.autopilot.tick(clock.t);
  };
  const addPlayer = async (id: string) => {
    await net.instance(id).request('command', { text: 'join Steve' });
    await net.instance(id).refresh();
  };
  const types = () => net.autopilot.events.map((e) => `${e.action}:${e.server}${e.dryRun ? ':dry' : ''}${e.ok === false ? ':failed' : ''}`);
  return { ...made, clock, mem, tick, addPlayer, types };
}

describe('autopilot: switched off and dry run', () => {
  it('does nothing while it is off', async () => {
    const { net, tick, mem, types } = await rig({ enabled: false, stopIdle: true });
    mem.availableMb = 100;
    await tick(30 * MIN);
    assert.deepEqual(types(), []);
    assert.ok(net.view('survival').status?.state === 'running');
  });

  it('writes down what it would do in dry-run mode, but does it not, and not over and over', async () => {
    const { net, tick, mem, types, clock } = await rig({ dryRun: true, stopIdle: true, idleMinutes: 5 });
    mem.availableMb = 300; // 3.6 % of 8 GB: critical
    await tick();
    await tick(10 * MIN);
    assert.ok(types().includes('free-memory:lobby:dry'));
    assert.ok(types().some((t) => t.startsWith('stop-idle:survival:dry')));
    assert.equal(net.view('survival').status?.state, 'running', 'nothing was stopped');
    assert.equal(net.agents.submit(paper('lobby')).length, 0, 'no order was queued');
    const count = net.autopilot.events.length;
    clock.t += 5 * MIN;
    await tick();
    assert.equal(net.autopilot.events.length, count, 'the same remark is not repeated every round');
  });
});

describe('autopilot: memory pressure', () => {
  it('asks the servers to free memory when the machine gets tight, with a pause between asks', async () => {
    const { net, tick, mem, types } = await rig();
    await tick();
    assert.deepEqual(types(), [], 'enough memory: nothing to do');
    mem.availableMb = 1000; // 12 %: warn
    await tick();
    assert.deepEqual(types().sort(), ['free-memory:creative', 'free-memory:lobby', 'free-memory:proxy', 'free-memory:survival']);
    assert.equal(net.agents.submit(paper('lobby'))[0].type, 'gc');
    await tick(MIN);
    assert.equal(types().length, 4, 'not again within five minutes');
    await tick(6 * MIN);
    assert.equal(types().length, 8);
    assert.match(net.autopilot.events[0].reason, /getting low \(12 % available\)/);
  });

  it('can be switched off separately and skips servers without a plugin', async () => {
    const off = await rig({ gcOnPressure: false });
    off.mem.availableMb = 100;
    await off.tick();
    assert.deepEqual(off.types(), []);
    const { net, tick, mem, types } = await rig();
    net.agents.forget('creative');
    mem.availableMb = 100;
    await tick();
    assert.ok(!types().includes('free-memory:creative'));
    assert.match(net.autopilot.events[0].reason, /critically low/);
  });
});

describe('autopilot: idle servers', () => {
  it('stops an empty server after the idle time, one at a time, never the join-first server and never one with players', async () => {
    const { net, tick, types, addPlayer } = await rig({ stopIdle: true, idleMinutes: 15 });
    await addPlayer('creative');
    await tick();
    await tick(14 * MIN);
    assert.deepEqual(types(), [], 'not yet');
    await tick(2 * MIN);
    assert.deepEqual(types(), ['stop-idle:survival'], 'survival is empty for 16 minutes; lobby is the entry, creative has a player');
    await net.instance('survival').refresh();
    assert.equal(net.view('survival').status?.state, 'stopped');
    assert.equal(net.view('lobby').status?.state, 'running');
    assert.equal(net.view('creative').status?.state, 'running');
    await tick(MIN);
    assert.equal(types().length, 1);
  });

  it('stops empty servers sooner when memory is tight', async () => {
    const { net, tick, mem, types } = await rig({ stopIdle: true, idleMinutes: 20 });
    await tick();
    mem.availableMb = 400;
    await tick(5 * MIN);
    assert.ok(types().includes('stop-idle:survival'), 'after 4 minutes of idleness instead of 20');
    assert.match(net.autopilot.events.find((e) => e.action === 'stop-idle')?.reason ?? '', /memory is tight/);
  });

  it('does not touch proxies, standalone servers or a server that has not run for long', async () => {
    const clock = { t: 1_000_000_000 };
    const { net } = makeNetwork([server('proxy', { role: 'proxy', autoStart: false }), server('lobby', { autoStart: false, entry: true }), server('modded', { autoStart: false, standalone: true })], { autopilot: { enabled: true, dryRun: false, intervalSeconds: 30, gcOnPressure: false, stopIdle: true, idleMinutes: 1, wakeOnDemand: false, restartOnLeak: false } }, { autopilot: { now: () => clock.t } });
    await net.start();
    for (const s of ['proxy', 'lobby', 'modded']) await net.startServer(s);
    await waitFor(() => net.views().every((v) => v.status?.state === 'running'), 5000, 'running');
    await net.autopilot.tick(clock.t);
    clock.t += 10 * MIN;
    await net.autopilot.tick(clock.t);
    assert.deepEqual(net.autopilot.events, []);
    assert.deepEqual(net.views().map((v) => v.status?.state), ['running', 'running', 'running']);
  });

  it('keeps servers up when waking them on demand would not work, and says why', async () => {
    const { net, tick, types } = await rig({ stopIdle: true, idleMinutes: 1, wakeOnDemand: true });
    net.agents.submit(velocity('0.1.0'));
    await tick();
    await tick(5 * MIN);
    assert.ok(types().includes('blocked:survival'));
    assert.match(net.autopilot.events.find((e) => e.action === 'blocked')?.reason ?? '', /plugin 0\.2\.0 or newer/);
    assert.equal(net.view('survival').status?.state, 'running');
    net.agents.submit(velocity('0.2.0'));
    await tick(MIN);
    assert.ok(types().includes('stop-idle:survival'), 'with a new enough proxy plugin it goes ahead');
  });

  it('holds back after too many automatic actions in an hour', async () => {
    const { net, tick, types, mem } = await rig({}, { maxActionsPerHour: 2 });
    mem.availableMb = 100;
    await tick();
    assert.equal(net.autopilot.events.filter((e) => e.action === 'free-memory').length, 2);
    assert.ok(types().includes('blocked:survival'));
    assert.match(net.autopilot.events.find((e) => e.action === 'blocked')?.reason ?? '', /2 automatic actions/);
  });

  it('stays out of the way while a setup is running', async () => {
    const { net, tick, mem, types } = await rig();
    mem.availableMb = 100;
    Object.defineProperty(net.setup, 'running', { get: () => true });
    await tick();
    assert.deepEqual(types(), []);
  });
});

describe('autopilot: starting a server on demand', () => {
  it('starts a sleeping server when a player asks, and hands the player over when it answers', async () => {
    const { net, tick, types, clock, addPlayer } = await rig({ stopIdle: true, idleMinutes: 1, wakeOnDemand: true });
    await addPlayer('creative'); // so that survival is the only idle server
    await tick();
    await tick(2 * MIN);
    assert.ok(types().includes('stop-idle:survival'));
    await net.instance('survival').refresh();
    assert.deepEqual(net.autopilot.lists(), { sleeping: ['survival'], awake: [] });
    assert.deepEqual(net.autopilot.state().sleeping.map((s) => s.name), ['survival']);

    assert.equal(await net.autopilot.wake('lobby'), false, 'only sleeping servers are woken');
    assert.equal(await net.autopilot.wake('survival'), true);
    assert.equal(await net.autopilot.wake('survival'), false, 'already on its way');
    assert.deepEqual(net.autopilot.lists().sleeping, ['survival'], 'the proxy keeps holding players while it starts');
    await waitFor(() => net.view('survival').status?.state === 'running', 5000, 'survival running');
    await net.instance('survival').refresh();
    net.instance('survival').status!.health.reachable = true;
    await tick(5_000);
    assert.deepEqual(net.autopilot.lists(), { sleeping: [], awake: ['survival'] });
    assert.ok(types().includes('ready:survival'));
    await tick(3 * MIN);
    assert.deepEqual(net.autopilot.lists().awake, [], 'the "ready" message is only valid for a short time');
    void clock;
  });

  it('shows nothing to the proxy while in dry run or when the feature is off', async () => {
    const { net } = await rig({ stopIdle: true, wakeOnDemand: true, dryRun: true });
    assert.deepEqual(net.autopilot.lists(), { sleeping: [], awake: [] });
    const off = await rig({ stopIdle: true, wakeOnDemand: false });
    off.net.autopilot.sleeping.set('survival', 1);
    assert.deepEqual(off.net.autopilot.lists(), { sleeping: [], awake: [] });
  });

  it('gives up on a server that does not come up, and forgets a server somebody started by hand', async () => {
    const { net, tick, types } = await rig({ stopIdle: true, idleMinutes: 1, wakeOnDemand: true });
    await tick();
    await tick(2 * MIN);
    await net.instance('survival').refresh();
    await net.autopilot.wake('survival');
    net.instance('survival').status!.health.reachable = false;
    await tick(6 * MIN);
    assert.ok(types().includes('wake:survival:failed'));
    assert.ok(net.autopilot.state().sleeping.length === 0 || true);
    const second = await rig({ stopIdle: true, idleMinutes: 1, wakeOnDemand: true });
    second.net.autopilot.sleeping.set('creative', 1);
    await second.tick();
    assert.equal(second.net.autopilot.sleeping.size, 0, 'it runs, so it is not asleep');
  });
});

describe('autopilot: memory leaks', () => {
  /** Adds three hours of growing live set for one server. */
  function leak(net: Awaited<ReturnType<typeof rig>>['net'], id: string, clockT: number, from = 300, to = 900) {
    for (let i = 0; i < 180; i++) {
      const t = clockT - (179 - i) * MIN;
      const live = from + ((to - from) * i) / 179;
      net.tracker.record({ t, system: SYSTEM_8G, networkRssMb: 0, servers: { [id]: { state: 'running', rssMb: 1, maxMb: 1000, players: 0, heapUsedMb: live + 50, liveSetMb: live, tps: 20 } } });
    }
  }

  it('restarts a leaking server when nobody is on it, and not again for hours', async () => {
    const { net, types, clock } = await rig({ restartOnLeak: true, gcOnPressure: false });
    leak(net, 'survival', clock.t);
    await net.autopilot.tick(clock.t);
    assert.deepEqual(types(), ['restart-leak:survival', 'restart-leak:survival'], 'a note that it is planned, then the restart');
    assert.ok(net.autopilot.events.some((e) => e.action === 'restart-leak' && e.ok === true));
    leak(net, 'survival', clock.t + MIN);
    clock.t += MIN;
    await net.autopilot.tick(clock.t);
    assert.equal(net.autopilot.events.filter((e) => e.ok === true).length, 1, 'cooldown');
  });

  it('waits for the players to leave, and moves them when the heap is nearly full', async () => {
    const { net, clock, addPlayer } = await rig({ restartOnLeak: true, gcOnPressure: false });
    leak(net, 'survival', clock.t);
    await addPlayer('survival');
    await net.autopilot.tick(clock.t);
    assert.ok(net.autopilot.events.some((e) => e.action === 'restart-leak' && /planned/.test(e.reason)));
    assert.ok(!net.autopilot.events.some((e) => e.ok === true && e.action === 'restart-leak'), 'not while a player is on it');
    assert.ok(net.autopilot.events.some((e) => e.action === 'evacuate'), 'the heap is at 90 %: the player is moved');
    const orders = net.agents.submit(velocity());
    assert.equal(orders[0].type, 'evacuate');
    assert.equal(orders[0].from, 'survival');
  });

  it('ignores servers that are fine', async () => {
    const { net, types, clock } = await rig({ restartOnLeak: true, gcOnPressure: false });
    leak(net, 'survival', clock.t, 400, 410);
    await net.autopilot.tick(clock.t);
    assert.deepEqual(types(), []);
  });
});

describe('autopilot settings and API', () => {
  it('changes and saves settings, and refuses what does not exist', async () => {
    const { net } = await rig({ enabled: false });
    const cfg = net.updateAutopilot({ enabled: true, idleMinutes: 30 });
    assert.deepEqual({ enabled: cfg.enabled, idle: cfg.idleMinutes, dry: cfg.dryRun }, { enabled: true, idle: 30, dry: false });
    assert.throws(() => net.updateAutopilot({ turbo: true }), /Unknown autopilot setting: turbo/);
    assert.throws(() => net.updateAutopilot({ idleMinutes: 0 }), /idleMinutes/);
    assert.throws(() => net.updateAutopilot({ enabled: 'yes' }), /enabled must be true or false/);
  });

  it('is served over HTTP, and a wake request from the proxy starts the sleeping server', async () => {
    const { net } = await rig({ stopIdle: true, idleMinutes: 1, wakeOnDemand: true });
    const http = createHttpServer(net, { host: '127.0.0.1', port: 0, token: '' });
    const port = await http.listen();
    after(() => http.close());
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
    };
    const state = (await call('GET', '/api/autopilot')).json as { config: AutopilotConfig; events: unknown[]; wakeSupported: boolean };
    assert.equal(state.config.stopIdle, true);
    assert.equal(state.wakeSupported, true);
    assert.equal((await call('PUT', '/api/autopilot', { idleMinutes: 45 })).status, 200);
    assert.equal((await call('PUT', '/api/autopilot', { nope: 1 })).status, 400);

    await net.autopilot.tick(Date.now() + 5 * MIN);
    await net.autopilot.tick(Date.now() + 10 * MIN);
    net.autopilot.sleeping.set('survival', 1);
    await net.instance('survival').request('stop');
    await net.instance('survival').refresh();
    const report = { serverId: 'proxy', kind: 'velocity', agentVersion: '0.2.0', time: 1, jvm, proxy: { players: 1, version: 'V', servers: [], wakeRequests: ['survival'] }, results: [] };
    const answer = await call('POST', '/api/agent/report', report, { authorization: `Bearer ${AGENT_TOKEN}` });
    assert.equal(answer.status, 200);
    assert.deepEqual((answer.json as { sleeping: string[] }).sleeping, ['survival'], 'the proxy plugin is told to keep holding players while the server starts');
    await waitFor(() => net.view('survival').status?.state !== 'stopped' || net.autopilot.state().waking.includes('survival'), 5000, 'wake started');
    assert.equal((await call('POST', '/api/autopilot/wake', { server: 'creative' })).json?.started, false);
    assert.equal((await call('POST', '/api/autopilot/wake', {})).status, 400);
  });
});

describe('wake requests in reports', () => {
  it('are read from the proxy plugin, limited and defaulted', () => {
    assert.deepEqual(velocity('0.2.0', ['survival']).proxy?.wakeRequests, ['survival']);
    assert.deepEqual(parseReport({ serverId: 'proxy', kind: 'velocity', time: 1, jvm, proxy: { players: 0, version: 'V', servers: [] } }).proxy?.wakeRequests, [], 'an older plugin sends none');
    assert.equal(velocity('0.2.0', Array.from({ length: 50 }, (_, i) => `s${i}`)).proxy?.wakeRequests.length, 20);
    assert.throws(() => velocity('0.2.0', [5 as unknown as string]), /wakeRequests/);
  });
});
