import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseReport } from '../src/agent/protocol';
import { AgentStore, CONNECTED_MS } from '../src/agent/store';

const report = (serverId = 'lobby', results: unknown[] = []) =>
  parseReport({ serverId, kind: 'paper', time: 1, jvm: { heapUsedMb: 1, heapCommittedMb: 2, heapMaxMb: 3, nonHeapUsedMb: 1, liveSetMb: null, gcCount: 0, gcTimeMs: 0, threads: 1, uptimeMs: 1, processors: 1, processCpu: null }, results });

describe('AgentStore', () => {
  it('keeps the latest report and tells when an agent counts as connected', () => {
    const store = new AgentStore();
    assert.equal(store.connected('lobby'), false);
    assert.equal(store.latest('lobby'), null);
    store.submit(report(), 1000);
    assert.equal(store.connected('lobby', 1000 + CONNECTED_MS - 1), true);
    assert.equal(store.connected('lobby', 1000 + CONNECTED_MS), false);
    assert.equal(store.latest('lobby')?.receivedAt, 1000);
  });

  it('hands out queued orders once, with the next report', () => {
    const store = new AgentStore();
    const a = store.enqueue('lobby', 'gc');
    const b = store.enqueue('lobby', 'evacuate', { from: 'lobby', to: 'survival' });
    assert.notEqual(a, b);
    const orders = store.submit(report());
    assert.deepEqual(orders.map((o) => o.type), ['gc', 'evacuate']);
    assert.equal(orders[1].to, 'survival');
    assert.deepEqual(store.submit(report()), [], 'delivered only once');
    assert.deepEqual(store.submit(report('other')), [], 'orders are per server');
  });

  it('records the outcome that comes back with a later report', () => {
    const store = new AgentStore();
    const id = store.enqueue('lobby', 'gc');
    assert.equal(store.commands('lobby')[0].done, false);
    store.submit(report());
    assert.equal(store.commands('lobby')[0].done, false, 'handed out but not finished yet');
    store.submit(report('lobby', [{ id, ok: true, message: 'freed 100 MB' }]));
    const [c] = store.commands('lobby');
    assert.deepEqual({ done: c.done, ok: c.ok, message: c.message, type: c.type }, { done: true, ok: true, message: 'freed 100 MB', type: 'gc' });
    store.submit(report('lobby', [{ id: 'unknown', ok: true, message: '' }])); // not ours: ignored
  });

  it('lists the newest orders first, keeps only a few, and can forget a server', () => {
    const store = new AgentStore();
    for (let i = 0; i < 25; i++) store.enqueue('lobby', 'gc');
    assert.equal(store.commands('lobby').length, 20);
    store.submit(report());
    store.forget('lobby');
    assert.equal(store.latest('lobby'), null);
    assert.deepEqual(store.commands('lobby'), []);
  });

  it('emits report events', () => {
    const store = new AgentStore();
    const seen: string[] = [];
    store.on('report', (r: { serverId: string }) => seen.push(r.serverId));
    store.submit(report('a'));
    store.submit(report('b'));
    assert.deepEqual(seen, ['a', 'b']);
  });
});
