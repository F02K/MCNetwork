/** What MCLI's `--api` mode sends (see MCLI docs/API.md). Only the fields MCNetwork uses are typed. */
export type ServerState = 'stopped' | 'starting' | 'running' | 'stopping';

export interface McliStatus {
  mcli: string;
  protocol: number;
  dir: string;
  state: ServerState;
  pid: number | null;
  startedAt: number | null;
  uptimeMs: number;
  restarts: number;
  software: { type: string; version: string | null; jar: string | null; build: string | null } | null;
  java: string;
  memory: { min: string; max: string; systemTotal: number; time: number; sysCpu: number; sysMemPercent: number; procRss: number; procCpu: number };
  players: { count: number; max: number | null; online: { name: string; since: number }[] };
  health: { reachable: boolean | null; latencyMs?: number; version?: string; motd?: string; online?: number; max?: number; port?: number };
  problems: { id: string; title: string; advice: string; fatal: boolean }[];
  installer: { busy: string | null; progress: { done: number; total: number } | null };
  backups: { busy: string | null; lastAt: number | null };
  updates: { checkedAt: number; error: string | null; sameMc: string | null; newerMc: string | null } | null;
}

/** "2G" / "512M" -> megabytes (0 for anything else). */
export function parseMemoryMb(value: string): number {
  const m = /^(\d+)([MG])$/i.exec(value);
  return m ? Number(m[1]) * (m[2].toUpperCase() === 'G' ? 1024 : 1) : 0;
}
