import type { MemorySettings, Role } from '../types';

export interface PlanServer {
  id: string;
  role: Role;
  memory: MemorySettings;
}

export interface PlanInput {
  totalMb: number;
  /** 0 = automatic: 12 % of the total, at least 1 GB. */
  reserveMb: number;
  servers: PlanServer[];
}

export interface Allocation {
  id: string;
  /** Heap the JVM may use (-Xmx). */
  xmxMb: number;
  /** Heap the JVM starts with (-Xms). */
  xmsMb: number;
  /** What the process will roughly occupy in RAM: heap plus JVM overhead. */
  expectedRssMb: number;
  /** Why this value: share, pinned, or clamped to a limit. */
  reason: 'share' | 'pinned' | 'min' | 'max';
}

export interface Plan {
  totalMb: number;
  reserveMb: number;
  /** RAM left for all servers together. */
  budgetMb: number;
  allocations: Allocation[];
  expectedRssMb: number;
  warnings: string[];
}

export const STEP_MB = 64;
const OVERHEAD_FIXED_MB = 256;
const OVERHEAD_RATIO = 0.15;

/** A proxy only forwards packets: it rarely needs more than 1 GB, however big the machine is. */
const DEFAULTS: Record<Role, { weight: number; minMb: number; maxMb: number }> = {
  proxy: { weight: 1, minMb: 256, maxMb: 1024 },
  backend: { weight: 4, minMb: 512, maxMb: Infinity },
};

/** RAM a JVM occupies for a heap: the heap plus metaspace, threads and native buffers. */
export const rssForHeap = (heapMb: number): number => heapMb + Math.max(OVERHEAD_FIXED_MB, heapMb * OVERHEAD_RATIO);

/** Inverse of rssForHeap. */
export function heapForRss(rssMb: number): number {
  const small = rssMb - OVERHEAD_FIXED_MB;
  return small <= OVERHEAD_FIXED_MB / OVERHEAD_RATIO ? small : rssMb / (1 + OVERHEAD_RATIO);
}

export const autoReserveMb = (totalMb: number): number => Math.max(1024, Math.round(totalMb * 0.12));

const floorStep = (mb: number): number => Math.floor(mb / STEP_MB) * STEP_MB;

interface Slot {
  server: PlanServer;
  weight: number;
  minRss: number;
  maxRss: number;
  rss: number;
  reason: Allocation['reason'];
  locked: boolean;
}

/**
 * Divides the RAM of the machine between the servers.
 * Pinned servers get exactly their size; the rest is shared by weight (water-filling: a server
 * that hits its minimum or maximum is fixed there and the others share what remains).
 * If even the minimums do not fit, everything gets its minimum and a warning says so.
 */
export function planRam(input: PlanInput): Plan {
  const reserveMb = input.reserveMb > 0 ? input.reserveMb : autoReserveMb(input.totalMb);
  const budgetMb = Math.max(0, input.totalMb - reserveMb);
  const warnings: string[] = [];

  const slots: Slot[] = input.servers.map((server) => {
    const m = server.memory;
    const def = DEFAULTS[server.role];
    const minHeap = Math.max(m.minMb ?? def.minMb, 64);
    const pinned = m.pinnedMb;
    const minRss = rssForHeap(pinned ?? minHeap);
    const maxHeap = m.maxMb ?? def.maxMb;
    const maxRss = pinned !== undefined ? minRss : Number.isFinite(maxHeap) ? Math.max(minRss, rssForHeap(maxHeap)) : Infinity;
    return { server, weight: m.weight ?? def.weight, minRss, maxRss, rss: minRss, reason: pinned !== undefined ? 'pinned' : 'share', locked: pinned !== undefined };
  });

  let remaining = budgetMb - slots.filter((s) => s.locked).reduce((sum, s) => sum + s.rss, 0);
  let open = slots.filter((s) => !s.locked);
  const minTotal = open.reduce((sum, s) => sum + s.minRss, 0);
  if (remaining < minTotal) {
    warnings.push(`Not enough RAM: the servers need at least ${Math.ceil(minTotal + (budgetMb - remaining))} MB, but only ${Math.round(budgetMb)} MB are available for them. Everyone gets the minimum.`);
    for (const s of open) {
      s.locked = true;
      s.reason = 'min';
    }
    open = [];
  }

  while (open.length) {
    const weights = open.reduce((sum, s) => sum + s.weight, 0);
    const clamped = open.filter((s) => {
      const share = (remaining * s.weight) / weights;
      return share < s.minRss || share > s.maxRss;
    });
    if (!clamped.length) {
      for (const s of open) s.rss = (remaining * s.weight) / weights;
      break;
    }
    // fix the most violated server first, then recompute for the rest
    const worst = clamped.reduce((a, b) => {
      const da = Math.max(a.minRss - (remaining * a.weight) / weights, (remaining * a.weight) / weights - a.maxRss);
      const db = Math.max(b.minRss - (remaining * b.weight) / weights, (remaining * b.weight) / weights - b.maxRss);
      return db > da ? b : a;
    });
    const share = (remaining * worst.weight) / weights;
    worst.rss = share < worst.minRss ? worst.minRss : worst.maxRss;
    worst.reason = share < worst.minRss ? 'min' : 'max';
    worst.locked = true;
    remaining -= worst.rss;
    open = open.filter((s) => s !== worst);
  }

  const allocations: Allocation[] = slots.map((s) => {
    const m = s.server.memory;
    const minHeap = Math.max(m.minMb ?? DEFAULTS[s.server.role].minMb, 64);
    let xmx: number;
    if (s.reason === 'pinned') xmx = m.pinnedMb ?? minHeap;
    else if (s.reason === 'min') xmx = minHeap;
    else if (s.reason === 'max') xmx = Math.max(m.maxMb ?? DEFAULTS[s.server.role].maxMb, minHeap);
    else xmx = Math.min(Math.max(floorStep(heapForRss(s.rss)), minHeap), m.maxMb ?? DEFAULTS[s.server.role].maxMb);
    // Proxies and pinned servers start with their full heap; game servers start smaller and grow.
    const xms = s.server.role === 'proxy' || s.reason === 'pinned' ? xmx : Math.min(xmx, Math.max(256, floorStep(xmx / 4)));
    return { id: s.server.id, xmxMb: xmx, xmsMb: xms, expectedRssMb: Math.round(rssForHeap(xmx)), reason: s.reason };
  });
  const expectedRssMb = allocations.reduce((sum, a) => sum + a.expectedRssMb, 0);
  if (expectedRssMb > budgetMb + 1 && !warnings.length) warnings.push(`The plan needs ${expectedRssMb} MB but only ${Math.round(budgetMb)} MB are available.`);
  return { totalMb: input.totalMb, reserveMb, budgetMb, allocations, expectedRssMb, warnings };
}
