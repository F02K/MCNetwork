import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectLeak, versionAtLeast } from '../src/autopilot/rules';
import type { RamFrame } from '../src/ram/tracker';

const NOW = 100 * 3_600_000;

/** One frame a minute for `minutes`, with the live set from `from` to `to` MB (plus noise). */
function frames(minutes: number, from: number, to: number, o: { maxMb?: number; noise?: number; state?: 'running' | 'stopped' } = {}): RamFrame[] {
  return Array.from({ length: minutes }, (_, i) => {
    const t = NOW - (minutes - 1 - i) * 60_000;
    const live = from + ((to - from) * i) / Math.max(1, minutes - 1) + (o.noise ? Math.sin(i * 7) * o.noise : 0);
    return { t, system: { totalMb: 8192, availableMb: 4000, usedMb: 4192 }, pressure: 'ok' as const, networkRssMb: 0, servers: { a: { state: o.state ?? 'running', rssMb: 1, maxMb: o.maxMb ?? 1000, players: 0, heapUsedMb: live + 50, liveSetMb: live, tps: 20 } } };
  });
}

describe('detectLeak', () => {
  it('recognises steady growth that nears the heap limit', () => {
    const v = detectLeak(frames(180, 300, 900), 'a', { now: NOW });
    assert.equal(v.leaking, true);
    assert.ok(Math.abs(v.slopeMbPerHour - 200) < 5, `slope ${v.slopeMbPerHour}`);
    assert.equal(detectLeak([...frames(180, 300, 900), { ...frames(1, 5, 5)[0], t: NOW + 3_600_000 }], 'a', { now: NOW }).liveMb, 900, 'a measurement from the future is ignored');
    assert.ok(v.fit > 0.99);
    assert.equal(v.liveMb, 900);
    assert.match(v.reason, /grows by about 20\d MB per hour and is at 90 % of the heap/);
  });

  it('is not alarmed by a stable, a noisy or a roomy memory need', () => {
    assert.equal(detectLeak(frames(180, 500, 505), 'a', { now: NOW }).leaking, false);
    assert.match(detectLeak(frames(180, 500, 505), 'a', { now: NOW }).reason, /stable/);
    const noisy = detectLeak(frames(180, 700, 720, { noise: 150 }), 'a', { now: NOW, minSlopeMbPerHour: 1 });
    assert.equal(noisy.leaking, false);
    assert.match(noisy.reason, /up and down/);
    const roomy = detectLeak(frames(180, 100, 400, { maxMb: 4000 }), 'a', { now: NOW });
    assert.equal(roomy.leaking, false);
    assert.match(roomy.reason, /plenty of room/);
  });

  it('gives no verdict without enough measurements, time or running state', () => {
    assert.match(detectLeak(frames(20, 300, 900), 'a', { now: NOW }).reason, /Not enough measurements/);
    assert.match(detectLeak(frames(70, 300, 900), 'a', { now: NOW }).reason, /too little time/);
    assert.equal(detectLeak(frames(180, 300, 900, { state: 'stopped' }), 'a', { now: NOW }).samples, 0);
    assert.equal(detectLeak(frames(180, 300, 900), 'ghost', { now: NOW }).leaking, false);
    const all = frames(180, 300, 900).map((f) => ({ ...f, servers: { a: { ...f.servers.a, liveSetMb: null } } }));
    assert.equal(detectLeak(all, 'a', { now: NOW }).samples, 0);
  });

  it('ignores measurements older than the window', () => {
    assert.equal(detectLeak(frames(180, 300, 900), 'a', { now: NOW + 10 * 3_600_000 }).samples, 0);
  });
});

describe('versionAtLeast', () => {
  it('compares dotted versions', () => {
    assert.equal(versionAtLeast('0.2.0', '0.2.0'), true);
    assert.equal(versionAtLeast('0.10.0', '0.2.0'), true);
    assert.equal(versionAtLeast('0.1.9', '0.2.0'), false);
    assert.equal(versionAtLeast('1.0', '0.2.0'), true);
    assert.equal(versionAtLeast(null, '0.2.0'), false);
    assert.equal(versionAtLeast('', '0.2.0'), false);
  });
});
