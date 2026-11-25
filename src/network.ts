import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveMcliPath, resolveServerDir, saveConfig, validateServer } from './config';
import { McliInstance, type InstanceOptions } from './mcli/instance';
import { parseMemoryMb, type McliStatus } from './mcli/protocol';
import { planRam, type Plan } from './ram/planner';
import { readSystemMemory, type Pressure, type SystemMemory } from './ram/system';
import { RamTracker, type RamFrame } from './ram/tracker';
import type { NetworkConfig, ServerConfig } from './types';

const MB = 1024 * 1024;
export const HISTORY_FILE = 'ram-history.json';

export interface NetworkOptions {
  /** Test hooks. */
  instance?: Partial<InstanceOptions>;
  systemMemory?: () => SystemMemory;
}

export interface ServerView {
  config: ServerConfig;
  connection: McliInstance['connection'];
  error: string | null;
  needsRestart: boolean;
  status: McliStatus | null;
}

export interface AppliedAllocation {
  id: string;
  xmxMb: number;
  xmsMb: number;
  /** The server runs with a different heap; the new one applies after a restart. */
  needsRestart: boolean;
}

/**
 * The network: all configured servers (one MCLI process each), RAM sampling and planning.
 * Events: 'server-event' ({id, event, data}), 'status' ({id, status}), 'ram' (RamFrame),
 * 'pressure' (Pressure, RamFrame), 'servers' (the list changed).
 */
export class Network extends EventEmitter {
  readonly tracker = new RamTracker();
  private instances = new Map<string, McliInstance>();
  private sampleTimer: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private pressure: Pressure = 'ok';
  private readonly readMemory: () => SystemMemory;

  constructor(
    readonly dataDir: string,
    readonly config: NetworkConfig,
    private opts: NetworkOptions = {},
  ) {
    super();
    this.readMemory = opts.systemMemory ?? readSystemMemory;
    this.tracker.load(join(dataDir, HISTORY_FILE));
  }

  // ------------------------------------------------------------ lifecycle

  /** Connects every server's MCLI and starts the ones marked autoStart (backends before the proxy). */
  async start(): Promise<void> {
    for (const s of this.config.servers) this.attach(s);
    await Promise.all([...this.instances.values()].map((i) => i.connect().catch(() => undefined)));
    await this.applyPlan().catch(() => undefined); // heap sizes must be in mcli.json before the first start
    for (const s of this.startOrder()) {
      if (s.autoStart) await this.startServer(s.id).catch(() => undefined);
    }
    this.sampleRam();
    this.sampleTimer = setInterval(() => this.sampleRam(), this.config.ram.sampleSeconds * 1000);
    this.saveTimer = setInterval(() => this.saveHistory(), 60_000);
    this.sampleTimer.unref();
    this.saveTimer.unref();
  }

  /** Stops proxies first, then the backends; every server shuts down gracefully. */
  async stop(): Promise<void> {
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    if (this.saveTimer) clearInterval(this.saveTimer);
    this.sampleTimer = this.saveTimer = null;
    const order = [...this.startOrder()].reverse();
    for (const role of ['proxy', 'backend'] as const) {
      await Promise.all(order.filter((s) => s.role === role).map(async (s) => this.instances.get(s.id)?.disconnect()));
    }
    this.saveHistory();
  }

  private startOrder(): ServerConfig[] {
    return [...this.config.servers].sort((a, b) => Number(a.role === 'proxy') - Number(b.role === 'proxy'));
  }

  private saveHistory(): void {
    try {
      this.tracker.save(join(this.dataDir, HISTORY_FILE));
    } catch {
      // history is a nice-to-have; a read-only disk must not stop the network
    }
  }

  // ------------------------------------------------------------ servers

  private attach(cfg: ServerConfig): McliInstance {
    const inst = new McliInstance(cfg.id, {
      dir: resolveServerDir(this.dataDir, cfg),
      mcliPath: resolveMcliPath(this.dataDir, this.config),
      ...this.opts.instance,
    });
    inst.on('event', (event: string, data: unknown) => this.emit('server-event', { id: cfg.id, event, data }));
    inst.on('status', (status: McliStatus) => this.emit('status', { id: cfg.id, status }));
    inst.on('connection', (connection: string) => this.emit('server-event', { id: cfg.id, event: 'connection', data: { connection } }));
    inst.on('respawned', () => {
      if (cfg.autoStart) void this.startServer(cfg.id).catch(() => undefined);
    });
    this.instances.set(cfg.id, inst);
    return inst;
  }

  instance(id: string): McliInstance {
    const inst = this.instances.get(id);
    if (!inst) throw new Error(`Unknown server "${id}"`);
    return inst;
  }

  view(id: string): ServerView {
    const inst = this.instance(id);
    const config = this.config.servers.find((s) => s.id === id) as ServerConfig;
    return { config, connection: inst.connection, error: inst.lastError, needsRestart: inst.needsRestart, status: inst.status };
  }

  views(): ServerView[] {
    return this.config.servers.map((s) => this.view(s.id));
  }

  async startServer(id: string): Promise<unknown> {
    return this.instance(id).request('start', {}, 120_000);
  }

  async addServer(input: unknown): Promise<ServerView> {
    const cfg = validateServer(input, this.dataDir);
    if (this.config.servers.some((s) => s.id === cfg.id)) throw new Error(`A server "${cfg.id}" already exists`);
    if (cfg.role === 'proxy' && this.config.servers.some((s) => s.role === 'proxy')) throw new Error('Only one proxy is supported for now');
    mkdirSync(resolveServerDir(this.dataDir, cfg), { recursive: true });
    this.config.servers.push(cfg);
    saveConfig(this.dataDir, this.config);
    const inst = this.attach(cfg);
    await inst.connect().catch(() => undefined);
    this.emit('servers');
    return this.view(cfg.id);
  }

  /** Removes a server from the network. Its folder and world stay on disk. */
  async removeServer(id: string): Promise<void> {
    const inst = this.instance(id);
    if (inst.status && inst.status.state !== 'stopped') throw new Error('Stop the server before removing it');
    await inst.disconnect();
    this.instances.delete(id);
    this.config.servers.splice(this.config.servers.findIndex((s) => s.id === id), 1);
    saveConfig(this.dataDir, this.config);
    this.emit('servers');
  }

  // ------------------------------------------------------------ RAM

  /** The RAM plan for the current server list. */
  plan(): Plan {
    const sys = this.readMemory();
    const { totalMb, reserveMb } = this.config.ram;
    return planRam({ totalMb: totalMb > 0 ? totalMb : sys.totalMb, reserveMb, servers: this.config.servers });
  }

  /** Writes the planned heap sizes to every connected MCLI. Running servers pick them up on restart. */
  async applyPlan(): Promise<{ plan: Plan; applied: AppliedAllocation[]; failed: { id: string; error: string }[] }> {
    const plan = this.plan();
    const applied: AppliedAllocation[] = [];
    const failed: { id: string; error: string }[] = [];
    for (const a of plan.allocations) {
      const inst = this.instances.get(a.id);
      if (!inst || inst.connection !== 'online') {
        failed.push({ id: a.id, error: 'not connected' });
        continue;
      }
      try {
        await inst.request('setMemory', { min: `${a.xmsMb}M`, max: `${a.xmxMb}M` });
        await inst.refresh();
        applied.push({ id: a.id, xmxMb: a.xmxMb, xmsMb: a.xmsMb, needsRestart: inst.needsRestart });
      } catch (err) {
        failed.push({ id: a.id, error: (err as Error).message });
      }
    }
    return { plan, applied, failed };
  }

  /** Takes one RAM measurement of the machine and every server. */
  sampleRam(now = Date.now()): RamFrame {
    const system = this.readMemory();
    const servers: RamFrame['servers'] = {};
    let networkRssMb = 0;
    for (const s of this.config.servers) {
      const st = this.instances.get(s.id)?.status;
      const rssMb = st && st.state !== 'stopped' ? Math.round(st.memory.procRss / MB) : 0;
      networkRssMb += rssMb;
      servers[s.id] = { state: st?.state ?? 'stopped', rssMb, maxMb: st ? parseMemoryMb(st.memory.max) : 0, players: st?.players.count ?? 0, heapUsedMb: null };
    }
    const frame = this.tracker.record({ t: now, system, networkRssMb, servers });
    this.emit('ram', frame);
    if (frame.pressure !== this.pressure) {
      this.pressure = frame.pressure;
      this.emit('pressure', frame.pressure, frame);
    }
    return frame;
  }
}
