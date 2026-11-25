import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveMcliPath, resolveServerDir, saveConfig, validateServer } from './config';
import { McliInstance, type InstanceOptions } from './mcli/instance';
import { parseMemoryMb, type McliStatus } from './mcli/protocol';
import { planRam, type Plan } from './ram/planner';
import { readSystemMemory, type Pressure, type SystemMemory } from './ram/system';
import { RamTracker, type RamFrame } from './ram/tracker';
import { proxyOf, writeProxyConfig } from './setup/layout';
import { SetupRunner, type SetupOptions } from './setup/provision';
import type { NetworkConfig, ServerConfig } from './types';

const MB = 1024 * 1024;
export const HISTORY_FILE = 'ram-history.json';

export interface NetworkOptions {
  /** Test hooks. */
  instance?: Partial<InstanceOptions>;
  systemMemory?: () => SystemMemory;
  setup?: SetupOptions;
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
  readonly setup: SetupRunner;
  private util: McliInstance | null = null;
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
    this.setup = new SetupRunner(this, opts.setup);
    this.setup.on('change', (state) => this.emit('setup', state));
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
    await this.util?.disconnect();
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
    const clash = cfg.port === undefined ? undefined : this.config.servers.find((s) => s.port === cfg.port);
    if (clash) throw new Error(`Port ${cfg.port} is already used by "${clash.id}"`);
    mkdirSync(resolveServerDir(this.dataDir, cfg), { recursive: true });
    this.config.servers.push(cfg);
    saveConfig(this.dataDir, this.config);
    const inst = this.attach(cfg);
    await inst.connect().catch(() => undefined);
    await this.syncProxy();
    this.emit('servers');
    return this.view(cfg.id);
  }

  /** Changes name, autoStart, memory limits or the join-first flag of a server. */
  async updateServer(id: string, patch: Record<string, unknown>): Promise<ServerView> {
    this.instance(id);
    const index = this.config.servers.findIndex((s) => s.id === id);
    const current = this.config.servers[index];
    const allowed = ['name', 'autoStart', 'memory', 'entry'];
    const unknown = Object.keys(patch).filter((k) => !allowed.includes(k));
    if (unknown.length) throw new Error(`Cannot change ${unknown.join(', ')}`);
    const next = validateServer({ ...current, ...patch, entry: patch.entry === undefined ? current.entry : patch.entry === true }, this.dataDir);
    if (next.entry && next.role !== 'backend') throw new Error('Only a game server can be the first stop for players');
    if (next.entry) for (const s of this.config.servers) if (s.id !== id) delete s.entry;
    this.config.servers[index] = next;
    saveConfig(this.dataDir, this.config);
    await this.syncProxy();
    this.emit('servers');
    return this.view(id);
  }

  /** Removes a server from the network. Its folder and world stay on disk. */
  async removeServer(id: string): Promise<void> {
    const inst = this.instance(id);
    if (inst.status && inst.status.state !== 'stopped') throw new Error('Stop the server before removing it');
    await inst.disconnect();
    this.instances.delete(id);
    this.config.servers.splice(this.config.servers.findIndex((s) => s.id === id), 1);
    saveConfig(this.dataDir, this.config);
    await this.syncProxy();
    this.emit('servers');
  }

  /**
   * Writes the server list into the proxy's velocity.toml and, when the proxy is running, asks it to
   * reload. Does nothing before the proxy has been started once (the file does not exist yet).
   */
  async syncProxy(): Promise<boolean> {
    const changed = writeProxyConfig(this.dataDir, this.config);
    const proxy = proxyOf(this.config);
    if (changed && proxy && this.instances.get(proxy.id)?.status?.state === 'running') await this.instance(proxy.id).request('command', { text: 'velocity reload' }).catch(() => undefined);
    return changed;
  }

  // ------------------------------------------------------------ versions

  /** A throwaway MCLI (no server) used to ask the download services. */
  private async lookup<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!this.util) {
      this.util = new McliInstance('(lookup)', { dir: join(this.dataDir, '.lookup'), mcliPath: resolveMcliPath(this.dataDir, this.config), ...this.opts.instance });
    }
    if (this.util.connection !== 'online') await this.util.connect();
    return this.util.request<T>(method, params, 30_000);
  }

  /** Release versions of a provider, newest first, and the one to preselect (a recommended/stable build among the newest). */
  async versionChoices(provider: 'paper' | 'velocity'): Promise<{ default: string; versions: string[] }> {
    const versions = await this.lookup<string[]>('versions', { provider, snapshots: false });
    if (!versions.length) throw new Error(`No ${provider} versions available`);
    // Velocity publishes its own recommendation, which can be several versions behind (4.x needs a newer Java than 3.x)
    const scan = provider === 'velocity' ? 12 : 6;
    const channels = await Promise.all(versions.slice(0, scan).map((version) => this.lookup<{ channel: string | null }>('plan', { provider, version }).then((p) => p.channel, () => null)));
    const pick = ['RECOMMENDED', 'STABLE'].map((c) => channels.indexOf(c)).find((i) => i >= 0);
    return { default: versions[pick ?? 0], versions };
  }

  defaultVersion(provider: 'paper' | 'velocity'): Promise<string> {
    return this.versionChoices(provider).then((c) => c.default);
  }

  // ------------------------------------------------------------ RAM

  /** The RAM plan for the current server list. */
  plan(): Plan {
    const sys = this.readMemory();
    const { totalMb, reserveMb } = this.config.ram;
    return planRam({ totalMb: totalMb > 0 ? totalMb : sys.totalMb, reserveMb, servers: this.config.servers });
  }

  /** Changes how much RAM MCNetwork plans with (0 = automatic). */
  updateRam(patch: Record<string, unknown>): { totalMb: number; reserveMb: number } {
    for (const key of Object.keys(patch)) if (key !== 'totalMb' && key !== 'reserveMb') throw new Error(`Cannot change ${key}`);
    for (const key of ['totalMb', 'reserveMb'] as const) {
      const v = patch[key];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`"${key}" must be a number >= 0 (0 = automatic)`);
      this.config.ram[key] = Math.round(v);
    }
    saveConfig(this.dataDir, this.config);
    return { totalMb: this.config.ram.totalMb, reserveMb: this.config.ram.reserveMb };
  }

  /** The plan for servers that do not exist yet (the wizard shows it before anything is created). */
  previewPlan(input: Record<string, unknown>): Plan {
    if (!Array.isArray(input.servers)) throw new Error('"servers" must be a list');
    const servers = input.servers.map((s) => {
      const v = validateServer({ ...(s as object), dir: 'x' }, this.dataDir);
      return { id: v.id, role: v.role, memory: v.memory };
    });
    const sys = this.readMemory();
    const reserve = typeof input.reserveMb === 'number' ? input.reserveMb : this.config.ram.reserveMb;
    return planRam({ totalMb: this.config.ram.totalMb > 0 ? this.config.ram.totalMb : sys.totalMb, reserveMb: reserve, servers });
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
