import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseReport } from '../src/agent/protocol';
import { makeAgentJars, makeNetwork, server, tmp, waitFor } from './helpers';

const jvm = { heapUsedMb: 410.4, heapCommittedMb: 512, heapMaxMb: 1024, nonHeapUsedMb: 90, liveSetMb: 250.2, gcCount: 5, gcTimeMs: 120, threads: 30, uptimeMs: 50000, processors: 4, processCpu: 0.1 };
const paperReport = (id: string, extra = {}) => parseReport({ serverId: id, kind: 'paper', agentVersion: '0.1.0', time: 1, jvm, game: { tps: [19.84, 20, 20], mspt: 4.1, players: 1, maxPlayers: 20, version: '1.21.8', worlds: [] }, ...extra });
const proxyReport = () => parseReport({ serverId: 'proxy', kind: 'velocity', agentVersion: '0.1.0', time: 1, jvm, proxy: { players: 1, version: 'Velocity', servers: [{ name: 'lobby', players: 1 }] } });

const lobbyAndProxy = () => makeNetwork([server('proxy', { role: 'proxy', autoStart: false }), server('lobby', { autoStart: false, entry: true }), server('survival', { autoStart: false })]);

describe('agent data in the network', () => {
  it('shows what a connected plugin reports, and nothing when it is silent', async () => {
    const { net } = lobbyAndProxy();
    await net.start();
    assert.equal(net.view('lobby').agent.connected, false);
    assert.equal(net.view('lobby').agent.game, null);
    net.agents.submit(paperReport('lobby'));
    const a = net.view('lobby').agent;
    assert.equal(a.connected, true);
    assert.equal(a.version, '0.1.0');
    assert.equal(a.bundledVersion, '0.1.0');
    assert.equal(a.outdated, false);
    assert.equal(a.jvm?.liveSetMb, 250.2);
    assert.equal(a.game?.tps[0], 19.84);
    net.agents.submit(paperReport('lobby', { agentVersion: '0.0.9' }));
    assert.equal(net.view('lobby').agent.outdated, true);
  });

  it('emits an agent event for every report of a known server', async () => {
    const { net } = lobbyAndProxy();
    await net.start();
    const seen: { id: string; connected: boolean }[] = [];
    net.on('agent', (e: { id: string; agent: { connected: boolean } }) => seen.push({ id: e.id, connected: e.agent.connected }));
    net.agents.submit(paperReport('lobby'));
    net.agents.submit(paperReport('stranger'));
    assert.deepEqual(seen, [{ id: 'lobby', connected: true }]);
  });

  it('puts the reported heap, live set and TPS into the RAM frames', async () => {
    const { net } = lobbyAndProxy();
    await net.start();
    await net.startServer('lobby');
    await waitFor(() => net.view('lobby').status?.state === 'running', 5000, 'running');
    net.agents.submit(paperReport('lobby'));
    const frame = net.sampleRam();
    assert.deepEqual({ used: frame.servers.lobby.heapUsedMb, live: frame.servers.lobby.liveSetMb, tps: frame.servers.lobby.tps }, { used: 410, live: 250, tps: 19.8 });
    assert.equal(frame.servers.survival.heapUsedMb, null, 'no plugin, no value');
  });

  it('installs the plugin when the server is stopped at start, and says when the plugins are missing', async () => {
    const { net, dir } = lobbyAndProxy();
    await net.start();
    // the fake MCLI reports "paper 1.21.8" for every server, so the stopped servers get their plugin at start
    assert.ok(existsSync(join(dir, 'servers', 'lobby', 'plugins', 'MCNetworkAgent.jar')));
    assert.ok(existsSync(join(dir, 'servers', 'proxy', 'plugins', 'MCNetworkAgent.jar')));

    const { net: bare } = makeNetwork([server('lobby', { autoStart: false })], {}, { agentJarsDir: tmp() });
    await bare.start();
    assert.match(bare.view('lobby').agent.error ?? '', /plugins are missing.*npm run build:agent/);
    assert.throws(() => bare.installAgent('lobby'), /npm run build:agent/);
    assert.equal(bare.ensureAgent('lobby'), null);
  });

  it('repairs an outdated jar and respects the switch', async () => {
    const jars = makeAgentJars('0.2.0');
    const { net, dir } = makeNetwork([server('lobby', { autoStart: false })], {}, { agentJarsDir: jars });
    await net.start();
    assert.equal(net.installAgent('lobby').jar, 'current');
    const { net: off } = makeNetwork([server('lobby', { autoStart: false })], { agent: { enabled: false, token: 'x' } });
    await off.start();
    assert.throws(() => off.installAgent('lobby'), /switched off/);
    assert.equal(existsSync(join(dir, 'servers', 'other')), false);
    const { net: noUrl } = makeNetwork([server('lobby', { autoStart: false })]);
    noUrl.daemonUrl = '';
    await noUrl.start();
    assert.throws(() => noUrl.installAgent('lobby'), /own address/);
  });

  it('forgets the agent of a removed server', async () => {
    const { net } = lobbyAndProxy();
    await net.start();
    net.agents.submit(paperReport('survival'));
    await net.removeServer('survival');
    assert.equal(net.agents.latest('survival'), null);
  });
});

describe('orders for the agents', () => {
  it('queues a gc for a connected server and refuses it for a silent one', async () => {
    const { net } = lobbyAndProxy();
    await net.start();
    assert.throws(() => net.agentCommand('lobby', 'gc'), /not connected/);
    net.agents.submit(paperReport('lobby'));
    const id = net.agentCommand('lobby', 'gc');
    assert.deepEqual(net.agents.submit(paperReport('lobby')).map((o) => [o.id, o.type]), [[id, 'gc']]);
    assert.throws(() => net.agentCommand('ghost', 'gc'), /Unknown server/);
    assert.throws(() => net.agentCommand('lobby', 'format'), /Unknown command/);
  });

  it('moves players off a server through the proxy agent', async () => {
    const { net } = lobbyAndProxy();
    await net.start();
    assert.throws(() => net.agentCommand('survival', 'evacuate', { to: 'lobby' }), /proxy agent is not connected/);
    net.agents.submit(proxyReport());
    const id = net.agentCommand('survival', 'evacuate', { to: 'lobby', message: 'Restart!' });
    const orders = net.agents.submit(proxyReport());
    assert.deepEqual(orders, [{ id, type: 'evacuate', from: 'survival', to: 'lobby', message: 'Restart!' }]);
    // without a target the entry server is used
    net.agentCommand('survival', 'evacuate');
    assert.equal(net.agents.submit(proxyReport())[0].to, 'lobby');
  });

  it('checks the evacuation request', async () => {
    const { net } = lobbyAndProxy();
    await net.start();
    net.agents.submit(proxyReport());
    assert.throws(() => net.agentCommand('proxy', 'evacuate', { to: 'lobby' }), /Only a game server/);
    assert.throws(() => net.agentCommand('survival', 'evacuate', { to: 'survival' }), /different server/);
    assert.throws(() => net.agentCommand('survival', 'evacuate', { to: 'proxy' }), /another game server/);
    assert.throws(() => net.agentCommand('lobby', 'evacuate'), /another game server/, 'no entry server other than itself');
  });

  it('reads recommendations from the measured history', async () => {
    const { net } = lobbyAndProxy();
    await net.start();
    const recs = net.recommendations();
    assert.deepEqual(recs.map((r) => r.id), ['proxy', 'lobby', 'survival']);
    assert.ok(recs.every((r) => r.state === 'collecting'));
  });
});
