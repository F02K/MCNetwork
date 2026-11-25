import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { recommend } from '../src/ram/recommend';
import type { RamFrame } from '../src/ram/tracker';

const frames = (n: number, server: Partial<RamFrame['servers'][string]>): RamFrame[] =>
  Array.from({ length: n }, (_, i) => ({
    t: 1_000_000 + i * 10_000,
    system: { totalMb: 8192, availableMb: 4000, usedMb: 4192 },
    pressure: 'ok' as const,
    networkRssMb: 0,
    servers: { a: { state: 'running' as const, rssMb: 0, maxMb: 4096, players: 0, heapUsedMb: 900, liveSetMb: 600, tps: 20, ...server } },
  }));
const now = 1_000_000 + 100 * 10_000;

describe('recommend', () => {
  it('waits for enough running measurements', () => {
    const [r] = recommend(frames(10, {}), ['a'], { now });
    assert.equal(r.state, 'collecting');
    assert.equal(r.recommendedMb, null);
    assert.match(r.reason, /10 of 60/);
    const [stopped] = recommend(frames(100, { state: 'stopped' }), ['a'], { now });
    assert.equal(stopped.state, 'collecting');
    const [noAgent] = recommend(frames(100, { liveSetMb: null, heapUsedMb: null }), ['a'], { now });
    assert.equal(noAgent.state, 'collecting');
    assert.equal(recommend(frames(100, {}), ['ghost'], { now })[0].state, 'collecting');
  });

  it('says a heap is too big and what could be freed', () => {
    const [r] = recommend(frames(100, { maxMb: 8192, liveSetMb: 700, heapUsedMb: 1500 }), ['a'], { now });
    assert.equal(r.state, 'too-big');
    assert.equal(r.recommendedMb, 1216); // 700 / 0.6 = 1166.7, rounded up to 64
    assert.equal(r.deltaMb, 8192 - 1216);
    assert.equal(r.peakLiveMb, 700);
    assert.equal(r.peakUsedMb, 1500);
  });

  it('warns when the heap is nearly full even after garbage collection', () => {
    const [r] = recommend(frames(100, { maxMb: 2048, liveSetMb: 1500, heapUsedMb: 2000 }), ['a'], { now });
    assert.equal(r.state, 'too-small');
    assert.equal(r.recommendedMb, 2560);
    assert.equal(r.deltaMb, 512);
  });

  it('leaves a fitting heap alone, also when a lot of garbage piles up before collections', () => {
    assert.equal(recommend(frames(100, { maxMb: 1536, liveSetMb: 700, heapUsedMb: 1000 }), ['a'], { now })[0].state, 'ok');
    assert.equal(recommend(frames(100, { maxMb: 2048, liveSetMb: 1000, heapUsedMb: 1990 }), ['a'], { now })[0].state, 'ok', 'a full heap with a moderate live set is just lazy garbage collection');
    assert.equal(recommend(frames(100, { maxMb: 2048, liveSetMb: 300, heapUsedMb: 1990 }), ['a'], { now })[0].state, 'too-big', 'little live data: the heap is larger than needed');
  });

  it('never suggests less than 256 MB and ignores frames outside the window', () => {
    assert.equal(recommend(frames(100, { maxMb: 4096, liveSetMb: 10, heapUsedMb: 50 }), ['a'], { now })[0].recommendedMb, 256);
    assert.equal(recommend(frames(100, {}), ['a'], { now: now + 48 * 3_600_000, windowMinutes: 60 })[0].state, 'collecting');
  });
});
