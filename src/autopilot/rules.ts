import type { RamFrame } from '../ram/tracker';

export interface LeakVerdict {
  leaking: boolean;
  /** How fast the memory need grows, MB per hour. */
  slopeMbPerHour: number;
  /** Latest heap still in use after garbage collection, and the heap limit. */
  liveMb: number;
  maxMb: number;
  /** How well a straight line fits (1 = perfectly steady growth). */
  fit: number;
  samples: number;
  reason: string;
}

export interface LeakOptions {
  windowHours?: number;
  /** Fewer measurements than this, or a shorter span than this share of the window: no verdict. */
  minSamples?: number;
  /** Growth below this (MB/hour) is normal (chunks and caches filling up). */
  minSlopeMbPerHour?: number;
  /** The live set has to be this share of the heap limit: growth that has room is no emergency. */
  minOccupancy?: number;
  now?: number;
}

/**
 * Looks for the pattern of a memory leak: the heap that stays in use after garbage collections grows steadily
 * for hours and is getting close to the limit. A line is fitted through the measurements (least squares).
 */
export function detectLeak(frames: RamFrame[], id: string, opts: LeakOptions = {}): LeakVerdict {
  const windowMs = (opts.windowHours ?? 3) * 3_600_000;
  const now = opts.now ?? Date.now();
  const points = frames
    .filter((f) => f.t >= now - windowMs && f.t <= now && f.servers[id]?.state === 'running' && f.servers[id].liveSetMb !== null)
    .map((f) => ({ h: (f.t - (now - windowMs)) / 3_600_000, y: f.servers[id].liveSetMb as number, max: f.servers[id].maxMb }));
  const none = (reason: string): LeakVerdict => ({ leaking: false, slopeMbPerHour: 0, liveMb: points[points.length - 1]?.y ?? 0, maxMb: points[points.length - 1]?.max ?? 0, fit: 0, samples: points.length, reason });
  if (points.length < (opts.minSamples ?? 60)) return none('Not enough measurements yet.');
  const span = points[points.length - 1].h - points[0].h;
  if (span < (opts.windowHours ?? 3) * 0.5) return none('The measurements cover too little time.');

  const n = points.length;
  const sx = points.reduce((a, p) => a + p.h, 0);
  const sy = points.reduce((a, p) => a + p.y, 0);
  const sxx = points.reduce((a, p) => a + p.h * p.h, 0);
  const sxy = points.reduce((a, p) => a + p.h * p.y, 0);
  const denom = n * sxx - sx * sx;
  if (denom === 0) return none('No time between the measurements.');
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const mean = sy / n;
  const ssTot = points.reduce((a, p) => a + (p.y - mean) ** 2, 0);
  const ssRes = points.reduce((a, p) => a + (p.y - (intercept + slope * p.h)) ** 2, 0);
  const fit = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  const last = points[points.length - 1];
  const occupancy = last.max > 0 ? last.y / last.max : 0;
  const base = { slopeMbPerHour: slope, liveMb: last.y, maxMb: last.max, fit, samples: n };
  if (slope < (opts.minSlopeMbPerHour ?? 20)) return { ...base, leaking: false, reason: 'The memory need is stable.' };
  if (fit < 0.7) return { ...base, leaking: false, reason: 'The memory need goes up and down, not steadily.' };
  if (occupancy < (opts.minOccupancy ?? 0.7)) return { ...base, leaking: false, reason: 'It grows, but there is still plenty of room.' };
  return { ...base, leaking: true, reason: `The memory in use after cleanup grows by about ${Math.round(slope)} MB per hour and is at ${Math.round(occupancy * 100)} % of the heap.` };
}

/** Compares "0.2.0" style versions: true when `have` is at least `need`. */
export function versionAtLeast(have: string | null | undefined, need: string): boolean {
  if (!have) return false;
  const a = have.split('.').map((n) => parseInt(n, 10) || 0);
  const b = need.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}
