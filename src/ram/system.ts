import { readFileSync } from 'node:fs';
import os from 'node:os';

export interface SystemMemory {
  totalMb: number;
  /** Memory that can be used without swapping (Linux "MemAvailable"). */
  availableMb: number;
  usedMb: number;
}

const MB = 1024 * 1024;

/** Reads a text file, or null when it does not exist (replaceable in tests). */
export type FileReader = (path: string) => string | null;

const readFile: FileReader = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null; // not Linux, or no such cgroup file
  }
};

/** Extracts MemTotal and MemAvailable (in MB) from /proc/meminfo text. */
export function parseMeminfo(text: string): { totalMb: number; availableMb: number } | null {
  const kb = (key: string) => {
    const m = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(text);
    return m ? Number(m[1]) : null;
  };
  const total = kb('MemTotal');
  const available = kb('MemAvailable');
  return total === null || available === null ? null : { totalMb: Math.floor(total / 1024), availableMb: Math.floor(available / 1024) };
}

/**
 * Memory of this machine. In a container (cgroup limit) the limit counts, not the host's RAM.
 * Linux uses MemAvailable (page cache is not "used"); other systems fall back to free memory.
 */
export function readSystemMemory(read: FileReader = readFile): SystemMemory {
  const info = parseMeminfo(read('/proc/meminfo') ?? '');
  let totalMb = info?.totalMb ?? Math.floor(os.totalmem() / MB);
  let availableMb = info?.availableMb ?? Math.floor(os.freemem() / MB);
  const limit = Number(read('/sys/fs/cgroup/memory.max')?.trim());
  const current = Number(read('/sys/fs/cgroup/memory.current')?.trim());
  if (Number.isFinite(limit) && limit > 0 && limit / MB < totalMb) {
    totalMb = Math.floor(limit / MB);
    // the cgroup counts page cache too, so take the smaller of both views
    if (Number.isFinite(current)) availableMb = Math.min(availableMb, Math.max(0, totalMb - Math.floor(current / MB)));
  }
  return { totalMb, availableMb, usedMb: Math.max(0, totalMb - availableMb) };
}

export type Pressure = 'ok' | 'warn' | 'critical';

/** How tight memory is: warn below 15 % available, critical below 7 %. */
export function pressureOf(mem: SystemMemory): Pressure {
  const free = mem.totalMb > 0 ? mem.availableMb / mem.totalMb : 1;
  return free < 0.07 ? 'critical' : free < 0.15 ? 'warn' : 'ok';
}
