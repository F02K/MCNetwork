import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { CONFIG_FILE, defaultConfig, insideDataDir, loadConfig, resolveServerDir, saveConfig, validateServer } from '../src/config';
import { tmp } from './helpers';

describe('validateServer', () => {
  const dir = tmp();

  it('fills in defaults', () => {
    const s = validateServer({ id: 'lobby' }, dir);
    assert.deepEqual(s, { id: 'lobby', name: 'lobby', role: 'backend', dir: join('servers', 'lobby'), autoStart: true, memory: {} });
  });

  it('accepts a full entry', () => {
    const s = validateServer({ id: 'proxy', name: 'Proxy', role: 'proxy', dir: 'p', autoStart: false, memory: { weight: 2, minMb: 256, maxMb: 1024 } }, dir);
    assert.equal(s.role, 'proxy');
    assert.equal(s.autoStart, false);
    assert.equal(s.memory.maxMb, 1024);
  });

  it('rejects bad input with a clear message', () => {
    assert.throws(() => validateServer(null, dir), /must be an object/);
    assert.throws(() => validateServer({ id: 'Bad Id' }, dir), /"id"/);
    assert.throws(() => validateServer({ id: 'a', role: 'boss' }, dir), /"role"/);
    assert.throws(() => validateServer({ id: 'a', dir: '../out' }, dir), /"dir"/);
    assert.throws(() => validateServer({ id: 'a', dir: '/etc' }, dir), /"dir"/);
    assert.throws(() => validateServer({ id: 'a', name: 5 }, dir), /"name"/);
    assert.throws(() => validateServer({ id: 'a', autoStart: 'yes' }, dir), /"autoStart"/);
    assert.throws(() => validateServer({ id: 'a', memory: 5 }, dir), /"memory"/);
    assert.throws(() => validateServer({ id: 'a', memory: { weight: 0 } }, dir), /memory.weight/);
    assert.throws(() => validateServer({ id: 'a', memory: { minMb: 10 } }, dir), /memory.minMb/);
    assert.throws(() => validateServer({ id: 'a', memory: { minMb: 2048, maxMb: 1024 } }, dir), /cannot be larger/);
  });
});

describe('insideDataDir', () => {
  it('only allows relative folders below the data directory', () => {
    const dir = tmp();
    assert.equal(insideDataDir(dir, 'servers/a'), true);
    assert.equal(insideDataDir(dir, 'a/../b'), true);
    assert.equal(insideDataDir(dir, '.'), false);
    assert.equal(insideDataDir(dir, '..'), false);
    assert.equal(insideDataDir(dir, 'a/../../b'), false);
    assert.equal(insideDataDir(dir, dir), false);
  });
});

describe('loadConfig / saveConfig', () => {
  it('returns the defaults when there is no file', () => {
    const cfg = loadConfig(tmp());
    assert.deepEqual({ ...cfg, agent: { ...cfg.agent, token: '' } }, { ...defaultConfig(), agent: { enabled: true, token: '' } });
    assert.match(cfg.agent.token, /^[0-9a-f]{48}$/, 'a token is generated');
  });

  it('round-trips a saved configuration', () => {
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.servers.push(validateServer({ id: 'lobby', memory: { weight: 3 } }, dir));
    saveConfig(dir, cfg);
    assert.deepEqual(loadConfig(dir), cfg);
    assert.equal(resolveServerDir(dir, cfg.servers[0]), join(dir, 'servers', 'lobby'));
  });

  it('merges partial sections with the defaults', () => {
    const dir = tmp();
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ http: { port: 9000 }, ram: { reserveMb: 2048 }, servers: [{ id: 'a' }] }));
    const cfg = loadConfig(dir);
    assert.equal(cfg.http.port, 9000);
    assert.equal(cfg.http.host, '127.0.0.1');
    assert.equal(cfg.ram.reserveMb, 2048);
    assert.equal(cfg.ram.sampleSeconds, 10);
    assert.equal(cfg.servers.length, 1);
  });

  it('keeps the agent token and generates one when it is missing', () => {
    const dir = tmp();
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ agent: { token: 'mine' } }));
    assert.equal(loadConfig(dir).agent.token, 'mine');
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ agent: { enabled: false, token: '' } }));
    const cfg = loadConfig(dir);
    assert.equal(cfg.agent.enabled, false);
    assert.ok(cfg.agent.token.length > 20);
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ agent: { enabled: 'yes' } }));
    assert.throws(() => loadConfig(dir), /agent.enabled/);
  });

  it('rejects broken files', () => {
    const dir = tmp();
    const write = (c: unknown) => writeFileSync(join(dir, CONFIG_FILE), typeof c === 'string' ? c : JSON.stringify(c));
    write('{ nope');
    assert.throws(() => loadConfig(dir), /Cannot parse/);
    write({ servers: [{ id: 'a' }, { id: 'a' }] });
    assert.throws(() => loadConfig(dir), /Duplicate server id "a"/);
    write({ http: { port: 'x' } });
    assert.throws(() => loadConfig(dir), /http.port/);
    write({ ram: { sampleSeconds: 0 } });
    assert.throws(() => loadConfig(dir), /ram.sampleSeconds/);
  });

  it('refuses to listen on a public address without a token', () => {
    const dir = tmp();
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ http: { host: '0.0.0.0' } }));
    assert.throws(() => loadConfig(dir), /token is required/);
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ http: { host: '0.0.0.0', token: 'secret' } }));
    assert.equal(loadConfig(dir).http.token, 'secret');
  });
});
