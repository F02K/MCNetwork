import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseReport, ReportError } from '../src/agent/protocol';

const jvm = { heapUsedMb: 300.5, heapCommittedMb: 512, heapMaxMb: 1024, nonHeapUsedMb: 90, liveSetMb: 180, gcCount: 12, gcTimeMs: 340, threads: 40, uptimeMs: 60000, processors: 4, processCpu: 0.12 };
const paper = { serverId: 'lobby', kind: 'paper', agentVersion: '0.1.0', time: 1, jvm, game: { tps: [20, 19.9, 19.5], mspt: 3.2, players: 2, maxPlayers: 20, version: '1.21.8', worlds: [{ name: 'world', chunks: 300, entities: 40, players: 2 }] }, results: [{ id: 'c1', ok: true, message: 'done' }] };

describe('parseReport', () => {
  it('reads a Paper report', () => {
    const r = parseReport(paper);
    assert.equal(r.serverId, 'lobby');
    assert.equal(r.jvm.liveSetMb, 180);
    assert.deepEqual(r.game?.tps, [20, 19.9, 19.5]);
    assert.equal(r.game?.worlds[0].name, 'world');
    assert.deepEqual(r.results, [{ id: 'c1', ok: true, message: 'done' }]);
    assert.equal(r.proxy, undefined);
  });

  it('reads a Velocity report and allows missing optional numbers', () => {
    const r = parseReport({ serverId: 'proxy', kind: 'velocity', time: 2, jvm: { ...jvm, heapMaxMb: null, liveSetMb: null, processCpu: undefined }, proxy: { players: 3, version: 'Velocity 3.5.1', servers: [{ name: 'lobby', players: 2 }, { name: 'survival', players: 1 }] } });
    assert.equal(r.proxy?.servers.length, 2);
    assert.equal(r.jvm.liveSetMb, null);
    assert.equal(r.jvm.processCpu, null);
    assert.equal(r.agentVersion, 'unknown');
    assert.deepEqual(r.results, []);
  });

  it('refuses anything that is not what an agent sends', () => {
    const bad = (patch: Record<string, unknown>, re: RegExp) => assert.throws(() => parseReport({ ...paper, ...patch }), (e: Error) => e instanceof ReportError && re.test(e.message));
    assert.throws(() => parseReport('x'), /must be an object/);
    assert.throws(() => parseReport(null), ReportError);
    bad({ kind: 'bukkit' }, /kind/);
    bad({ serverId: 5 }, /serverId/);
    bad({ time: 'now' }, /time/);
    bad({ jvm: 3 }, /jvm/);
    bad({ jvm: { ...jvm, heapUsedMb: 'lots' } }, /heapUsedMb/);
    bad({ jvm: { ...jvm, gcCount: Infinity } }, /gcCount/);
    bad({ game: { ...paper.game, tps: [1, 2, 3, 4] } }, /tps/);
    bad({ game: { ...paper.game, worlds: [5] } }, /worlds\[0\]/);
    bad({ results: [{ id: 5 }] }, /result id/);
  });

  it('limits sizes of lists and texts', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ name: `w${i}`, chunks: 1, entities: 1, players: 0 }));
    assert.equal(parseReport({ ...paper, game: { ...paper.game, worlds: many } }).game?.worlds.length, 50);
    assert.equal(parseReport({ ...paper, serverId: 'x'.repeat(100) }).serverId.length, 32);
    assert.equal(parseReport({ ...paper, results: Array.from({ length: 50 }, (_, i) => ({ id: `${i}`, ok: true })) }).results.length, 20);
  });
});
