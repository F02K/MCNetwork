import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { paperSupported, parseSetupRequest, type SetupState } from '../src/setup/provision';
import { makeNetwork, waitFor } from './helpers';

const request = (extra: Record<string, unknown> = {}) => ({
  proxy: { motd: 'My Network' },
  backends: [{ id: 'lobby', memory: { weight: 2 } }, { id: 'survival', version: '1.21.7', memory: { weight: 8 } }],
  acceptEula: true,
  ...extra,
});

const net = (opts = {}) => makeNetwork([], {}, { setup: { pollMs: 20, isPortFree: () => Promise.resolve(true), ...opts } });
const finished = (n: ReturnType<typeof makeNetwork>['net']) => waitFor(() => n.setup.state && n.setup.state.status !== 'running', 20_000, 'setup to finish');
const read = (dir: string, ...p: string[]) => readFileSync(join(dir, ...p), 'utf8');

describe('parseSetupRequest', () => {
  it('requires the EULA and at least one game server', () => {
    assert.throws(() => parseSetupRequest(request({ acceptEula: false }), []), /EULA/);
    assert.throws(() => parseSetupRequest(request({ backends: [] }), []), /at least one game server/);
    assert.throws(() => parseSetupRequest('x', []), /must be an object/);
  });

  it('rejects bad ids, duplicates, existing servers and old Paper versions', () => {
    const one = (b: unknown) => request({ backends: [b] });
    assert.throws(() => parseSetupRequest(one({ id: 'Bad Id' }), []), /backends\[0\]\.id/);
    assert.throws(() => parseSetupRequest(one({ id: 'proxy' }), []), /used twice/);
    assert.throws(() => parseSetupRequest(request({ backends: [{ id: 'a' }, { id: 'a' }] }), []), /used twice/);
    assert.throws(() => parseSetupRequest(one({ id: 'a' }), ['a']), /already exists/);
    assert.throws(() => parseSetupRequest(one({ id: 'a', version: '1.18.2' }), []), /too old/);
    assert.throws(() => parseSetupRequest(one({ id: 'a', version: 5 }), []), /must be a string/);
    assert.throws(() => parseSetupRequest(request({ proxy: { port: 99999 } }), []), /proxy\.port/);
    assert.throws(() => parseSetupRequest(request({ proxy: 5 }), []), /"proxy"/);
  });

  it('fills in defaults', () => {
    const r = parseSetupRequest(request(), []);
    assert.equal(r.start, true);
    assert.equal(r.backends[0].entry, false);
    assert.equal(r.proxy.port, undefined);
    assert.equal(parseSetupRequest(request({ start: false, ram: { reserveMb: 2048 } }), []).ram?.reserveMb, 2048);
  });

  it('knows which Paper versions have the new config layout', () => {
    assert.equal(paperSupported('1.21.8'), true);
    assert.equal(paperSupported('1.19'), true);
    assert.equal(paperSupported('1.18.2'), false);
    assert.equal(paperSupported('26.2'), true);
  });
});

describe('SetupRunner', () => {
  it('builds a working network: servers, ports, software, forwarding, server list, start', async () => {
    const { net: n, dir } = net();
    await n.start();
    const states: SetupState[] = [];
    n.on('setup', (s: SetupState) => states.push(JSON.parse(JSON.stringify(s)) as SetupState));
    n.setup.start(request({ proxy: { motd: 'My "Network"' } }));
    await finished(n);
    const state = n.setup.state as SetupState;
    assert.equal(state.status, 'done', state.error ?? '');
    assert.ok(state.steps.every((s) => s.status === 'done'));
    assert.ok(states.length > 10, 'progress was reported step by step');
    assert.match(state.steps.find((s) => s.id === 'install:proxy')?.detail ?? '', /velocity 3\.5\.1/); // the RECOMMENDED one
    assert.match(state.steps.find((s) => s.id === 'install:survival')?.detail ?? '', /paper 1\.21\.7/);
    assert.match(state.steps.find((s) => s.id === 'install:lobby')?.detail ?? '', /paper 1\.21\.8/);

    const cfg = n.config.servers;
    assert.deepEqual(cfg.map((s) => [s.id, s.role, s.port, s.entry ?? false]), [['proxy', 'proxy', 25565, false], ['lobby', 'backend', 30066, true], ['survival', 'backend', 30067, false]]);

    const toml = read(dir, 'servers', 'proxy', 'velocity.toml');
    assert.match(toml, /^bind = "0\.0\.0\.0:25565"$/m);
    assert.match(toml, /^motd = "My \\"Network\\""$/m);
    assert.match(toml, /^player-info-forwarding-mode = "modern"$/m);
    assert.match(toml, /^lobby = "127\.0\.0\.1:30066"$/m);
    assert.match(toml, /^survival = "127\.0\.0\.1:30067"$/m);
    assert.match(toml, /^try = \["lobby"\]$/m);

    for (const [id, port] of [['lobby', 30066], ['survival', 30067]] as const) {
      const props = read(dir, 'servers', id, 'server.properties');
      assert.match(props, new RegExp(`server-port=${port}`));
      assert.match(props, /server-ip=127\.0\.0\.1/);
      assert.match(props, /online-mode=false/);
      assert.match(read(dir, 'servers', id, 'config', 'paper-global.yml'), /velocity:\n {4}enabled: true\n {4}online-mode: true\n {4}secret: 'fake-secret-123'/);
      assert.ok(existsSync(join(dir, 'servers', id, 'eula.txt')));
    }
    // the agent plugins were put in place before the first start, configured for their server
    assert.match(state.steps.find((s) => s.id === 'install:proxy')?.detail ?? '', /\+ agent 0\.1\.0/);
    assert.equal(read(dir, 'servers', 'proxy', 'plugins', 'MCNetworkAgent.jar'), 'fake velocity jar 0.1.0');
    assert.equal(read(dir, 'servers', 'lobby', 'plugins', 'MCNetworkAgent.jar'), 'fake paper jar 0.1.0');
    assert.match(read(dir, 'servers', 'lobby', 'plugins', 'MCNetworkAgent', 'config.properties'), /^token=test-agent-token\nserver-id=lobby$/m);
    assert.match(read(dir, 'servers', 'proxy', 'plugins', 'mcnetwork-agent', 'config.properties'), /^server-id=proxy$/m);
    await waitFor(() => n.views().every((v) => v.status?.state === 'running'), 5000, 'everything running');
  });

  it('rejects a second setup while one runs and bad input before it starts', async () => {
    const { net: n } = net();
    await n.start();
    assert.throws(() => n.setup.start(request({ acceptEula: false })), /EULA/);
    assert.equal(n.setup.state, null);
    const current = () => n.setup.state;
    n.setup.start(request({ start: false }));
    assert.throws(() => n.setup.start(request()), /already running/);
    await finished(n);
    assert.equal(current()?.status, 'done');
    assert.equal(current()?.steps.some((s) => s.id === 'start'), false);
    assert.throws(() => n.setup.start(request()), /already exists/);
  });

  it('stops at the failing step and says which one', async () => {
    const { net: n } = net();
    await n.start();
    n.setup.start(request({ backends: [{ id: 'lobby', version: '0.0' }] }));
    await finished(n);
    const state = n.setup.state as SetupState;
    assert.equal(state.status, 'failed');
    assert.match(state.error ?? '', /download of paper 0\.0 failed/);
    assert.equal(state.steps.find((s) => s.id === 'install:lobby')?.status, 'failed');
    assert.equal(state.steps.find((s) => s.id === 'connect')?.status, 'pending');
  });

  it('fails clearly when a server never writes its settings', async () => {
    process.env.FAKE_NO_FILES = '1';
    try {
      const { net: n } = net({ bootstrapTimeoutMs: 400 });
      await n.start();
      n.setup.start(request());
      await finished(n);
      assert.equal(n.setup.state?.status, 'failed');
      assert.match(n.setup.state?.error ?? '', /did not write its settings in time/);
    } finally {
      delete process.env.FAKE_NO_FILES;
    }
  });
});

describe('proxy sync', () => {
  it('keeps velocity.toml in step with the server list and reloads a running proxy', async () => {
    const { net: n, dir } = net();
    await n.start();
    n.setup.start(request());
    await finished(n);
    assert.equal(n.setup.state?.status, 'done', n.setup.state?.error ?? '');
    await waitFor(() => n.view('proxy').status?.state === 'running', 5000, 'proxy running');

    await n.addServer({ id: 'creative', port: 30070 });
    assert.match(read(dir, 'servers', 'proxy', 'velocity.toml'), /^creative = "127\.0\.0\.1:30070"$/m);
    assert.match(read(dir, 'servers', 'proxy', 'commands.log'), /velocity reload/);
    await assert.rejects(() => n.addServer({ id: 'dup', port: 30070 }), /Port 30070 is already used by "creative"/);

    await n.removeServer('creative');
    assert.ok(!read(dir, 'servers', 'proxy', 'velocity.toml').includes('creative'));
  });

  it('does nothing without a proxy or before the proxy wrote its file', async () => {
    const { net: n } = net();
    await n.start();
    assert.equal(await n.syncProxy(), false);
    await n.addServer({ id: 'proxy', role: 'proxy', port: 25565 });
    assert.equal(await n.syncProxy(), false);
  });
});

describe('adding game servers to an existing network', () => {
  it('installs only the new servers and tells the running proxy about them', async () => {
    const { net: n, dir } = net();
    await n.start();
    n.setup.start(request());
    await finished(n);
    assert.equal(n.setup.state?.status, 'done', n.setup.state?.error ?? '');
    await waitFor(() => n.views().every((v) => v.status?.state === 'running'), 5000, 'everything running');

    n.setup.start({ backends: [{ id: 'creative', entry: false }], acceptEula: true });
    await finished(n);
    const state = n.setup.state;
    assert.equal(state.status, 'done', state.error ?? '');
    assert.deepEqual(state.steps.map((s) => s.id).filter((id) => id.startsWith('install:')), ['install:creative']);
    assert.equal(n.config.servers.find((s) => s.id === 'creative')?.port, 30068);
    assert.equal(n.config.servers.filter((s) => s.role === 'proxy').length, 1);
    assert.match(read(dir, 'servers', 'proxy', 'velocity.toml'), /^creative = "127\.0\.0\.1:30068"$/m);
    assert.match(read(dir, 'servers', 'proxy', 'commands.log'), /velocity reload/);
    assert.equal(n.config.servers.filter((s) => s.entry).length, 1, 'still exactly one entry server');
    await waitFor(() => n.view('creative').status?.state === 'running', 5000, 'new server running');
  });
});

