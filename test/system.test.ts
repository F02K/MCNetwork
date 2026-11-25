import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseMeminfo, pressureOf, readSystemMemory, type FileReader } from '../src/ram/system';

const MEMINFO = 'MemTotal:       16384000 kB\nMemFree:         1000000 kB\nMemAvailable:    8192000 kB\nBuffers: 1 kB\n';

describe('parseMeminfo', () => {
  it('reads total and available memory', () => {
    assert.deepEqual(parseMeminfo(MEMINFO), { totalMb: 16000, availableMb: 8000 });
  });
  it('returns null for anything else', () => {
    assert.equal(parseMeminfo(''), null);
    assert.equal(parseMeminfo('MemTotal: 5 kB\n'), null);
  });
});

describe('readSystemMemory', () => {
  const files = (map: Record<string, string>): FileReader => (path) => map[path] ?? null;

  it('uses /proc/meminfo when present', () => {
    assert.deepEqual(readSystemMemory(files({ '/proc/meminfo': MEMINFO })), { totalMb: 16000, availableMb: 8000, usedMb: 8000 });
  });

  it('respects a container (cgroup) limit', () => {
    const mem = readSystemMemory(files({ '/proc/meminfo': MEMINFO, '/sys/fs/cgroup/memory.max': String(4096 * 1024 * 1024), '/sys/fs/cgroup/memory.current': String(1024 * 1024 * 1024) }));
    assert.deepEqual(mem, { totalMb: 4096, availableMb: 3072, usedMb: 1024 });
  });

  it('ignores "max" (no limit) and a limit above the physical RAM', () => {
    assert.equal(readSystemMemory(files({ '/proc/meminfo': MEMINFO, '/sys/fs/cgroup/memory.max': 'max\n' })).totalMb, 16000);
    assert.equal(readSystemMemory(files({ '/proc/meminfo': MEMINFO, '/sys/fs/cgroup/memory.max': String(64 * 1024 ** 3) })).totalMb, 16000);
  });

  it('falls back to the os module without /proc', () => {
    const mem = readSystemMemory(() => null);
    assert.ok(mem.totalMb > 0 && mem.availableMb >= 0 && mem.usedMb >= 0);
  });
});

describe('pressureOf', () => {
  it('rates available memory', () => {
    assert.equal(pressureOf({ totalMb: 1000, availableMb: 500, usedMb: 500 }), 'ok');
    assert.equal(pressureOf({ totalMb: 1000, availableMb: 100, usedMb: 900 }), 'warn');
    assert.equal(pressureOf({ totalMb: 1000, availableMb: 50, usedMb: 950 }), 'critical');
    assert.equal(pressureOf({ totalMb: 0, availableMb: 0, usedMb: 0 }), 'ok');
  });
});
