import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { RamTracker, type RamFrame } from '../src/ram/tracker';
import { tmp } from './helpers';

const sys = { totalMb: 1000, availableMb: 500, usedMb: 500 };
const frame = (t: number, rssMb = 100, availableMb = 500): Omit<RamFrame, 'pressure'> => ({
  t,
  system: { ...sys, availableMb },
  networkRssMb: rssMb,
  servers: { a: { state: 'running', rssMb, maxMb: 1024, players: 0, heapUsedMb: null, liveSetMb: null, tps: null } },
});

describe('RamTracker', () => {
  it('records frames with their pressure and keeps only the newest', () => {
    const t = new RamTracker(3);
    for (let i = 1; i <= 5; i++) t.record(frame(i));
    assert.equal(t.size, 3);
    assert.equal(t.latest?.t, 5);
    assert.equal(t.record(frame(6, 100, 40)).pressure, 'critical');
  });

  it('returns the requested time range, thinned out when there are many points', () => {
    const t = new RamTracker();
    const now = 10_000_000;
    for (let i = 99; i >= 0; i--) t.record(frame(now - i * 60_000)); // oldest first, like real sampling
    assert.equal(t.history(10, 500, now).length, 11);
    const thin = t.history(120, 20, now);
    assert.equal(thin.length, 20);
    assert.ok(thin[0].t <= thin[19].t);
  });

  it('finds the peak RSS per server in a window', () => {
    const t = new RamTracker();
    t.record(frame(1_000, 300));
    t.record(frame(2_000, 900));
    t.record(frame(3_000, 400));
    assert.deepEqual(t.peaks(1, 3_000), { a: 900 });
    assert.deepEqual(t.peaks(1, 10_000_000), {});
  });

  it('saves and loads its history and ignores damaged files', () => {
    const file = join(tmp(), 'h.json');
    const t = new RamTracker();
    t.record(frame(1));
    t.record(frame(2));
    t.save(file);
    const loaded = new RamTracker();
    loaded.load(file);
    assert.equal(loaded.size, 2);
    writeFileSync(file, 'garbage');
    loaded.load(file);
    assert.equal(loaded.size, 0);
    loaded.load(join(tmp(), 'missing.json')); // no file: nothing happens
    writeFileSync(file, '{"not":"a list"}');
    loaded.load(file);
    assert.equal(loaded.size, 0);
  });
});
