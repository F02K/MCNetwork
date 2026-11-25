import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { McliInstance } from '../src/mcli/instance';
import { FAKE_MCLI, tmp, waitFor } from './helpers';

function make(env: Record<string, string> = {}, opts: Partial<ConstructorParameters<typeof McliInstance>[1]> = {}) {
  const dir = join(tmp(), 'srv');
  Object.assign(process.env, { FAKE_EXIT_AT_START: '', FAKE_CRASH_MS: '' }, env);
  const inst = new McliInstance('srv', { dir, mcliPath: FAKE_MCLI, respawnMs: 30, requestTimeoutMs: 3000, stopTimeoutMs: 3000, statusMs: 60_000, ...opts });
  return { inst, dir };
}

describe('McliInstance', () => {
  it('connects, creates the folder, answers requests and reports the status', async () => {
    const { inst } = make();
    await inst.connect();
    assert.equal(inst.connection, 'online');
    assert.equal(inst.status?.state, 'stopped');
    assert.equal(await inst.request('players').then((p) => (p as { count: number }).count), 0);
    await inst.request('start');
    await waitFor(() => inst.status?.state === 'running', 3000, 'running state');
    assert.equal(inst.status?.memory.procRss, 600 * 1024 * 1024);
    await inst.disconnect();
    assert.equal(inst.connection, 'offline');
  });

  it('rejects with the error text MCLI sends', async () => {
    const { inst } = make();
    await inst.connect();
    await assert.rejects(() => inst.request('setMemory', { max: 'lots' }), /Memory must look like/);
    await assert.rejects(() => inst.request('nope'), /Unknown method/);
    await inst.disconnect();
  });

  it('emits MCLI events and the connection state', async () => {
    const { inst } = make();
    const events: string[] = [];
    const states: string[] = [];
    inst.on('event', (name: string) => events.push(name));
    inst.on('connection', (c: string) => states.push(c));
    await inst.connect();
    await inst.request('start');
    await waitFor(() => events.includes('state'), 3000, 'state event');
    assert.deepEqual(states, ['connecting', 'online']);
    await inst.disconnect();
    assert.equal(states[states.length - 1], 'offline');
  });

  it('tells when the configured heap differs from the running one', async () => {
    const { inst } = make();
    await inst.connect();
    await inst.request('start');
    await waitFor(() => inst.status?.state === 'running', 3000, 'running');
    assert.equal(inst.activeMaxMb, 2048);
    assert.equal(inst.needsRestart, false);
    await inst.request('setMemory', { max: '4G' });
    await inst.refresh();
    assert.equal(inst.needsRestart, true);
    await inst.request('stop');
    await inst.refresh();
    assert.equal(inst.needsRestart, false);
    await inst.disconnect();
  });

  it('fails when MCLI cannot start, and keeps the reason', async () => {
    const { inst } = make({ FAKE_EXIT_AT_START: '1' });
    await assert.rejects(() => inst.connect(), /ended unexpectedly/);
    assert.equal(inst.connection, 'failed');
    assert.match(inst.lastError ?? '', /exit code 3/);
    await assert.rejects(() => inst.request('status'), /not running/);
  });

  it('fails when the MCLI file does not exist', async () => {
    const { inst } = make({}, { mcliPath: '/nonexistent/mcli.js' });
    await assert.rejects(() => inst.connect());
    assert.equal(inst.connection, 'failed');
  });

  it('starts MCLI again after an unexpected exit, up to a limit', async () => {
    const { inst } = make({ FAKE_CRASH_MS: '150' }, { maxRespawns: 2 });
    let respawned = 0;
    inst.on('respawned', () => respawned++);
    await inst.connect();
    await waitFor(() => respawned === 2 && inst.connection === 'failed', 6000, 'two respawns, then give up');
    assert.equal(inst.status?.state, 'stopped');
    await inst.disconnect();
  });

  it('times out requests that never get an answer', async () => {
    const { inst } = make();
    await inst.connect();
    await assert.rejects(() => inst.request('hang', {}, 100), /hang timed out/);
    assert.equal(await inst.request('ping').catch((e: Error) => e.message), 'Unknown method "ping"'); // still usable
    await inst.disconnect();
  });
});
