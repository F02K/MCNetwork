import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config';
import { HISTORY_FILE } from '../src/network';
import { makeNetwork, server, SYSTEM_8G, waitFor } from './helpers';

const proxy = (extra = {}) => server('proxy', { role: 'proxy', ...extra });

describe('Network', () => {
  it('connects every server, starts the autoStart ones and reports their views', async () => {
    const { net } = makeNetwork([proxy(), server('lobby'), server('manual', { autoStart: false })]);
    await net.start();
    await waitFor(() => net.view('proxy').status?.state === 'running' && net.view('lobby').status?.state === 'running', 5000, 'autoStart');
    assert.equal(net.view('manual').status?.state, 'stopped');
    assert.deepEqual(net.views().map((v) => v.connection), ['online', 'online', 'online']);
    assert.throws(() => net.view('ghost'), /Unknown server "ghost"/);
  });

  it('writes the planned heap into every MCLI before the first start', async () => {
    const { net } = makeNetwork([proxy(), server('lobby', { memory: { weight: 4 } }), server('survival', { memory: { weight: 8 } })]);
    await net.start();
    const plan = net.plan();
    for (const a of plan.allocations) assert.equal(net.view(a.id).status?.memory.max, `${a.xmxMb}M`);
    assert.ok(plan.allocations.find((a) => a.id === 'survival')!.xmxMb > plan.allocations.find((a) => a.id === 'lobby')!.xmxMb);
  });

  it('flags a running server that needs a restart for a new heap, and skips offline ones', async () => {
    const { net } = makeNetwork([server('lobby', { autoStart: false }), server('survival')]);
    await net.start();
    await waitFor(() => net.view('survival').status?.state === 'running', 5000, 'running');
    net.config.servers[1].memory.pinnedMb = 3000;
    const result = await net.applyPlan();
    assert.equal(result.applied.find((a) => a.id === 'survival')?.needsRestart, true);
    assert.equal(result.applied.find((a) => a.id === 'lobby')?.needsRestart, false);
    assert.equal(net.view('survival').needsRestart, true);
    await net.instance('lobby').disconnect();
    const again = await net.applyPlan();
    assert.deepEqual(again.failed, [{ id: 'lobby', error: 'not connected' }]);
  });

  it('samples RAM per server and for the network, and emits frames and pressure changes', async () => {
    let mem = SYSTEM_8G;
    const { net } = makeNetwork([proxy(), server('lobby')], {}, { systemMemory: () => mem });
    await net.start();
    await waitFor(() => net.view('lobby').status?.state === 'running', 5000, 'running');
    const frames: number[] = [];
    const pressure: string[] = [];
    net.on('ram', (f: { t: number }) => frames.push(f.t));
    net.on('pressure', (p: string) => pressure.push(p));
    const frame = net.sampleRam(1000);
    assert.equal(frame.servers.lobby.rssMb, 600);
    assert.equal(frame.servers.lobby.state, 'running');
    assert.equal(frame.networkRssMb, 1200);
    assert.equal(frame.pressure, 'ok');
    mem = { totalMb: 8192, availableMb: 200, usedMb: 7992 };
    assert.equal(net.sampleRam(2000).pressure, 'critical');
    assert.deepEqual(frames, [1000, 2000]);
    assert.deepEqual(pressure, ['critical']);
    assert.ok(net.tracker.size >= 3);
  });

  it('adds and removes servers and keeps mcnetwork.json in sync', async () => {
    const { net, dir } = makeNetwork([]);
    await net.start();
    const view = await net.addServer({ id: 'lobby', memory: { weight: 2 } });
    assert.equal(view.connection, 'online');
    assert.ok(existsSync(join(dir, 'servers', 'lobby')));
    assert.deepEqual(loadConfig(dir).servers.map((s) => s.id), ['lobby']);
    await assert.rejects(() => net.addServer({ id: 'lobby' }), /already exists/);
    await assert.rejects(() => net.addServer({ id: 'Bad' }), /"id"/);
    await net.addServer({ id: 'proxy', role: 'proxy' });
    await assert.rejects(() => net.addServer({ id: 'proxy2', role: 'proxy' }), /Only one proxy/);

    await net.instance('lobby').request('start');
    await net.instance('lobby').refresh();
    await assert.rejects(() => net.removeServer('lobby'), /Stop the server/);
    await net.instance('lobby').request('stop');
    await net.instance('lobby').refresh();
    await net.removeServer('lobby');
    assert.deepEqual(loadConfig(dir).servers.map((s) => s.id), ['proxy']);
    assert.ok(existsSync(join(dir, 'servers', 'lobby')), 'files stay on disk');
    assert.throws(() => net.instance('lobby'), /Unknown server/);
  });

  it('stops everything gracefully and saves the RAM history', async () => {
    const { net, dir } = makeNetwork([proxy(), server('lobby')]);
    await net.start();
    await waitFor(() => net.view('lobby').status?.state === 'running', 5000, 'running');
    await net.stop();
    assert.deepEqual(net.views().map((v) => v.connection), ['offline', 'offline']);
    const saved = JSON.parse(readFileSync(join(dir, HISTORY_FILE), 'utf8')) as unknown[];
    assert.ok(saved.length >= 1);
  });

  it('starts a server again after its MCLI had to be restarted', async () => {
    const { net } = makeNetwork([server('lobby')]);
    await net.start();
    await waitFor(() => net.view('lobby').status?.state === 'running', 5000, 'running');
    const inst = net.instance('lobby');
    const pid = inst.status?.pid;
    process.kill(pid as number, 'SIGKILL'); // the fake MCLI is the server process here
    await waitFor(() => inst.connection === 'online' && inst.status?.state === 'running' && inst.status.pid !== pid, 6000, 'respawn + autoStart');
  });

  it('changes a server\'s settings and keeps exactly one entry server', async () => {
    const { net: n, dir } = makeNetwork([server('lobby', { autoStart: false, port: 30066, entry: true }), server('survival', { autoStart: false, port: 30067 })]);
    await n.start();
    const view = await n.updateServer('survival', { name: 'Survival', autoStart: true, memory: { weight: 9 }, entry: true });
    assert.equal(view.config.name, 'Survival');
    assert.equal(view.config.memory.weight, 9);
    assert.equal(n.config.servers.find((s) => s.id === 'lobby')?.entry, undefined);
    assert.deepEqual(loadConfig(dir).servers.find((s) => s.id === 'survival')?.entry, true);
    await n.updateServer('survival', { entry: false });
    assert.equal(n.config.servers.find((s) => s.id === 'survival')?.entry, undefined);
    await assert.rejects(() => n.updateServer('survival', { port: 5 }), /Cannot change port/);
    await assert.rejects(() => n.updateServer('survival', { memory: { weight: -1 } }), /memory.weight/);
    await assert.rejects(() => n.updateServer('ghost', {}), /Unknown server/);
    await n.addServer({ id: 'proxy', role: 'proxy', port: 25565 });
    await assert.rejects(() => n.updateServer('proxy', { entry: true }), /Only a game server/);
  });

  it('previews a plan for servers that do not exist yet', () => {
    const { net: n } = makeNetwork([]);
    const plan = n.previewPlan({ servers: [{ id: 'proxy', role: 'proxy' }, { id: 'a', memory: { weight: 2 } }], reserveMb: 2048 });
    assert.equal(plan.reserveMb, 2048);
    assert.deepEqual(plan.allocations.map((a) => a.id), ['proxy', 'a']);
    assert.throws(() => n.previewPlan({}), /must be a list/);
    assert.throws(() => n.previewPlan({ servers: [{ id: 'BAD' }] }), /"id"/);
    assert.equal(n.previewPlan({ servers: [] }).reserveMb, 1024); // automatic: 12 % of 8 GB is below the 1 GB minimum
  });

  it('changes the RAM settings with validation and saves them', () => {
    const { net: n, dir } = makeNetwork([]);
    assert.deepEqual(n.updateRam({ reserveMb: 2048.4 }), { totalMb: 0, reserveMb: 2048 });
    assert.equal(loadConfig(dir).ram.reserveMb, 2048);
    assert.equal(n.plan().reserveMb, 2048);
    assert.deepEqual(n.updateRam({ totalMb: 4096 }), { totalMb: 4096, reserveMb: 2048 });
    assert.equal(n.plan().totalMb, 4096);
    assert.throws(() => n.updateRam({ reserveMb: -1 }), /"reserveMb"/);
    assert.throws(() => n.updateRam({ totalMb: 'x' }), /"totalMb"/);
    assert.throws(() => n.updateRam({ sampleSeconds: 1 }), /Cannot change sampleSeconds/);
  });
});
