import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { ServerState } from '../mcli/protocol';
import { pressureOf, type Pressure, type SystemMemory } from './system';

/** One measurement of the whole network. */
export interface RamFrame {
  /** Epoch ms. */
  t: number;
  system: SystemMemory;
  pressure: Pressure;
  /** Sum of the RSS of all server processes. */
  networkRssMb: number;
  servers: Record<string, ServerRam>;
}

export interface ServerRam {
  state: ServerState;
  /** Resident memory of the process (heap + JVM overhead). */
  rssMb: number;
  /** Configured -Xmx for the next/current start. */
  maxMb: number;
  players: number;
  /** Heap in use, as reported by the server plugin (null without it). */
  heapUsedMb: number | null;
  /** Heap still in use after the last garbage collection: what the server really needs. */
  liveSetMb: number | null;
  /** Ticks per second (1 minute average); game servers only. */
  tps: number | null;
}

export const DEFAULT_CAPACITY = 8640; // 24 h at 10 s

/** Keeps the recent RAM history in memory and on disk (one JSON file, written on demand). */
export class RamTracker {
  private frames: RamFrame[] = [];

  constructor(private capacity = DEFAULT_CAPACITY) {}

  record(frame: Omit<RamFrame, 'pressure'>): RamFrame {
    const full: RamFrame = { ...frame, pressure: pressureOf(frame.system) };
    this.frames.push(full);
    if (this.frames.length > this.capacity) this.frames.splice(0, this.frames.length - this.capacity);
    return full;
  }

  get latest(): RamFrame | null {
    return this.frames[this.frames.length - 1] ?? null;
  }

  get size(): number {
    return this.frames.length;
  }

  /** The last `minutes` of history, thinned out to at most `maxPoints` frames. */
  history(minutes: number, maxPoints = 500, now = Date.now()): RamFrame[] {
    const since = now - minutes * 60_000;
    const inRange = this.frames.filter((f) => f.t >= since);
    if (inRange.length <= maxPoints) return inRange;
    const step = inRange.length / maxPoints;
    return Array.from({ length: maxPoints }, (_, i) => inRange[Math.min(inRange.length - 1, Math.floor(i * step))]);
  }

  /** Highest RSS per server within the last `minutes`. */
  peaks(minutes: number, now = Date.now()): Record<string, number> {
    const out: Record<string, number> = {};
    for (const f of this.frames) {
      if (f.t < now - minutes * 60_000) continue;
      for (const [id, s] of Object.entries(f.servers)) out[id] = Math.max(out[id] ?? 0, s.rssMb);
    }
    return out;
  }

  save(file: string): void {
    writeFileSync(`${file}.tmp`, JSON.stringify(this.frames));
    renameSync(`${file}.tmp`, file);
  }

  /** Loads a saved history; a missing or damaged file is ignored (history is a nice-to-have). */
  load(file: string): void {
    if (!existsSync(file)) return;
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as RamFrame[];
      if (Array.isArray(data)) this.frames = data.filter((f) => typeof f?.t === 'number').slice(-this.capacity);
    } catch {
      this.frames = [];
    }
  }
}
