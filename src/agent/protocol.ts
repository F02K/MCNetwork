/** What the Paper and Velocity agents send (see agent/core Reporter.java). Input from outside: everything is checked. */
export interface AgentJvm {
  heapUsedMb: number;
  heapCommittedMb: number;
  heapMaxMb: number | null;
  nonHeapUsedMb: number;
  /** Heap still in use after the last garbage collection: what the server really needs. */
  liveSetMb: number | null;
  gcCount: number;
  gcTimeMs: number;
  threads: number;
  uptimeMs: number;
  processors: number;
  /** 0..1 of the whole machine. */
  processCpu: number | null;
}

export interface AgentWorld {
  name: string;
  chunks: number;
  entities: number;
  players: number;
}

export interface AgentGame {
  /** Averages over 1, 5 and 15 minutes (20 is perfect). */
  tps: number[];
  /** Average milliseconds per tick (50 is the limit). */
  mspt: number | null;
  players: number;
  maxPlayers: number;
  version: string;
  worlds: AgentWorld[];
}

export interface AgentProxy {
  players: number;
  version: string;
  servers: { name: string; players: number }[];
}

export interface CommandResult {
  id: string;
  ok: boolean;
  message: string;
}

export interface AgentReport {
  serverId: string;
  kind: 'paper' | 'velocity';
  agentVersion: string;
  time: number;
  jvm: AgentJvm;
  game?: AgentGame;
  proxy?: AgentProxy;
  results: CommandResult[];
}

export interface AgentCommandOut {
  id: string;
  type: 'gc' | 'evacuate';
  [key: string]: unknown;
}

export class ReportError extends Error {}

const obj = (v: unknown, what: string): Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ReportError(`"${what}" must be an object`);
  return v as Record<string, unknown>;
};

const num = (v: unknown, what: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ReportError(`"${what}" must be a number`);
  return v;
};

const numOrNull = (v: unknown, what: string): number | null => (v === null || v === undefined ? null : num(v, what));

const text = (v: unknown, what: string, max = 100): string => {
  if (typeof v !== 'string') throw new ReportError(`"${what}" must be a string`);
  return v.slice(0, max);
};

function parseJvm(raw: unknown): AgentJvm {
  const j = obj(raw, 'jvm');
  return {
    heapUsedMb: num(j.heapUsedMb, 'jvm.heapUsedMb'),
    heapCommittedMb: num(j.heapCommittedMb, 'jvm.heapCommittedMb'),
    heapMaxMb: numOrNull(j.heapMaxMb, 'jvm.heapMaxMb'),
    nonHeapUsedMb: num(j.nonHeapUsedMb, 'jvm.nonHeapUsedMb'),
    liveSetMb: numOrNull(j.liveSetMb, 'jvm.liveSetMb'),
    gcCount: num(j.gcCount, 'jvm.gcCount'),
    gcTimeMs: num(j.gcTimeMs, 'jvm.gcTimeMs'),
    threads: num(j.threads, 'jvm.threads'),
    uptimeMs: num(j.uptimeMs, 'jvm.uptimeMs'),
    processors: num(j.processors, 'jvm.processors'),
    processCpu: numOrNull(j.processCpu, 'jvm.processCpu'),
  };
}

function parseGame(raw: unknown): AgentGame {
  const g = obj(raw, 'game');
  if (!Array.isArray(g.tps) || g.tps.length > 3) throw new ReportError('"game.tps" must be a list of up to 3 numbers');
  const worlds = Array.isArray(g.worlds) ? g.worlds.slice(0, 50) : [];
  return {
    tps: g.tps.map((t, i) => num(t, `game.tps[${i}]`)),
    mspt: numOrNull(g.mspt, 'game.mspt'),
    players: num(g.players, 'game.players'),
    maxPlayers: num(g.maxPlayers, 'game.maxPlayers'),
    version: text(g.version ?? '', 'game.version'),
    worlds: worlds.map((w, i) => {
      const o = obj(w, `game.worlds[${i}]`);
      return { name: text(o.name, 'world name'), chunks: num(o.chunks, 'world chunks'), entities: num(o.entities, 'world entities'), players: num(o.players, 'world players') };
    }),
  };
}

function parseProxy(raw: unknown): AgentProxy {
  const p = obj(raw, 'proxy');
  const servers = Array.isArray(p.servers) ? p.servers.slice(0, 100) : [];
  return {
    players: num(p.players, 'proxy.players'),
    version: text(p.version ?? '', 'proxy.version'),
    servers: servers.map((s, i) => {
      const o = obj(s, `proxy.servers[${i}]`);
      return { name: text(o.name, 'server name'), players: num(o.players, 'server players') };
    }),
  };
}

/** Validates a report from the wire. Throws ReportError with a message for the agent's log. */
export function parseReport(body: unknown): AgentReport {
  const b = obj(body, 'report');
  const kind = b.kind;
  if (kind !== 'paper' && kind !== 'velocity') throw new ReportError('"kind" must be "paper" or "velocity"');
  const results = Array.isArray(b.results) ? b.results.slice(0, 20) : [];
  return {
    serverId: text(b.serverId, 'serverId', 32),
    kind,
    agentVersion: text(b.agentVersion ?? 'unknown', 'agentVersion', 32),
    time: num(b.time, 'time'),
    jvm: parseJvm(b.jvm),
    game: kind === 'paper' && b.game !== undefined ? parseGame(b.game) : undefined,
    proxy: kind === 'velocity' && b.proxy !== undefined ? parseProxy(b.proxy) : undefined,
    results: results.map((r, i) => {
      const o = obj(r, `results[${i}]`);
      return { id: text(o.id, 'result id', 40), ok: o.ok === true, message: text(o.message ?? '', 'result message', 300) };
    }),
  };
}
