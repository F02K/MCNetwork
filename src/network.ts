import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { basename, join, relative, resolve, isAbsolute } from 'node:path';
import { resolveMcliPath, resolveServerDir, saveConfig, validateServer } from './config';
import { installAgent, loadManifest, type InstallResult } from './agent/install';
import { AgentStore, type PendingCommand } from './agent/store';
import type { AgentGame, AgentJvm, AgentProxy } from './agent/protocol';
import { McliInstance, type InstanceOptions } from './mcli/instance';
import { parseMemoryMb, type McliStatus } from './mcli/protocol';
import { planRam, type Plan } from './ram/planner';
import { recommend, type Recommendation } from './ram/recommend';
import { readSystemMemory, type Pressure, type SystemMemory } from './ram/system';
import { RamTracker, type RamFrame } from './ram/tracker';
import { isListening } from './setup/probe';
import { PortAccess, type PortTools } from './ports/access';
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
  /** Test hooks for UPnP, firewall detection and the reachability check. */
  portTools?: PortTools;
  /** Folder with the agent plugin jars and manifest.json (default: ../agent/jars next to the bundle). */
  agentJarsDir?: string;
}

export interface ServerView {
  config: ServerConfig;
  connection: McliInstance['connection'];
  error: string | null;
  needsRestart: boolean;
  status: McliStatus | null;
  agent: AgentView;
}

/** What the Paper/Velocity plugin of one server reports, and its state. */
export interface AgentView {
  enabled: boolean;
  connected: boolean;
  lastSeen: number | null;
  /** Version of the plugin that reports. */
  version: string | null;
  /** Version MCNetwork would install. */
  bundledVersion: string | null;
  /** The plugin that runs is older than the bundled one (the new jar loads at the next restart). */
  outdated: boolean;
  /** Why the plugin is not installed, if it could not be. */
  error: string | null;
  jvm: AgentJvm | null;
  game: AgentGame | null;
  proxy: AgentProxy | null;
  commands: PendingCommand[];
}

/** What MCNetwork can do with an existing folder. */
export type ImportSupport = 'full' | 'convert' | 'standalone' | 'proxy' | 'none';

/** MCLI's findings about an existing server folder, plus what that means for joining this network. */
export interface ImportReport {
  dir: string;
  exists: boolean;
  isDirectory: boolean;
  software: { type: string; version: string | null; jar: string | null } | null;
  javaMajor: number | null;
  eula: 'accepted' | 'declined' | 'missing';
  properties: { port: number | null; ip: string; onlineMode: boolean | null; motd: string | null; levelName: string | null } | null;
  worlds: string[];
  plugins: string[];
  mods: number;
  sizeBytes: number;
  managedByMcli: boolean;
  files: { velocityToml: boolean; paperGlobal: boolean; forwardingSecret: boolean };
  warnings: string[];
  /** full: Paper, joins as it is. convert: Spigot, can become Paper. standalone: managed only. proxy: a Velocity proxy. */
  support: ImportSupport;
  /** Reasons why it cannot be imported right now. */
  issues: string[];
  /** A free id derived from the folder name. */
  suggestedId: string;
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
  readonly agents = new AgentStore();
  readonly access: PortAccess;
  /** Where the plugins reach this daemon; set once the HTTP server listens. */
  daemonUrl = '';
  private agentErrors = new Map<string, string>();
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
    this.access = new PortAccess(this, opts.portTools);
    this.setup = new SetupRunner(this, opts.setup);
    this.setup.on('change', (state) => this.emit('setup', state));
    this.agents.on('report', (r: { serverId: string }) => {
      if (this.instances.has(r.serverId)) this.emit('agent', { id: r.serverId, agent: this.agentView(r.serverId) });
    });
  }

  // ------------------------------------------------------------ lifecycle

  /** Connects every server's MCLI and starts the ones marked autoStart (backends before the proxy). */
  async start(): Promise<void> {
    for (const s of this.config.servers) this.attach(s);
    await Promise.all([...this.instances.values()].map((i) => i.connect().catch(() => undefined)));
    await this.applyPlan().catch(() => undefined); // heap sizes must be in mcli.json before the first start
    for (const s of this.config.servers) {
      if (this.instances.get(s.id)?.status?.software && this.instances.get(s.id)?.status?.state === 'stopped') this.ensureAgent(s.id); // keeps the plugin up to date
    }
    for (const s of this.startOrder()) {
      if (s.autoStart) await this.startServer(s.id).catch(() => undefined);
    }
    void this.access.start();
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
    await this.access.stop();
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
    return { config, connection: inst.connection, error: inst.lastError, needsRestart: inst.needsRestart, status: inst.status, agent: this.agentView(id) };
  }

  views(): ServerView[] {
    return this.config.servers.map((s) => this.view(s.id));
  }

  // ------------------------------------------------------------ agent plugins

  get agentJarsDir(): string {
    return this.opts.agentJarsDir ?? join(__dirname, '..', 'agent', 'jars');
  }

  /** Puts the plugin and its configuration into the server's folder (before its first start, or when it is stopped). */
  installAgent(id: string): InstallResult {
    this.instance(id);
    const cfg = this.config.servers.find((s) => s.id === id) as ServerConfig;
    const software = this.instances.get(id)?.status?.software?.type;
    if (software && software !== 'paper' && software !== 'velocity') throw new Error(`The agent plugin needs Paper or Velocity (this is ${software})`);
    if (!this.config.agent.enabled) throw new Error('The agent plugins are switched off (agent.enabled)');
    if (!this.daemonUrl) throw new Error('The daemon does not know its own address yet');
    const result = installAgent(resolveServerDir(this.dataDir, cfg), cfg.role, this.agentJarsDir, { url: this.daemonUrl, token: this.config.agent.token, serverId: id, intervalSeconds: Math.min(30, this.config.ram.sampleSeconds) });
    this.agentErrors.delete(id);
    return result;
  }

  /** Like installAgent, but a problem is remembered for the dashboard instead of thrown. */
  ensureAgent(id: string): InstallResult | null {
    const software = this.instances.get(id)?.status?.software?.type;
    if (software && software !== 'paper' && software !== 'velocity') return null; // nothing to install for Fabric, Forge, Spigot, ...
    try {
      return this.installAgent(id);
    } catch (err) {
      this.agentErrors.set(id, (err as Error).message);
      return null;
    }
  }

  /** Version of the plugins MCNetwork would install, or null when they were not built. */
  get bundledAgentVersion(): string | null {
    return loadManifest(this.agentJarsDir)?.version ?? null;
  }

  agentView(id: string): AgentView {
    const cfg = this.config.servers.find((s) => s.id === id);
    const manifest = loadManifest(this.agentJarsDir);
    const latest = this.agents.latest(id);
    const connected = this.agents.connected(id);
    const version = latest?.report.agentVersion ?? null;
    const bundledVersion = manifest?.version ?? null;
    return {
      enabled: this.config.agent.enabled,
      connected,
      lastSeen: latest?.receivedAt ?? null,
      version,
      bundledVersion,
      outdated: !!version && !!bundledVersion && version !== bundledVersion,
      error: this.agentErrors.get(id) ?? (this.config.agent.enabled && !manifest && cfg ? 'The agent plugins are not built (npm run build:agent)' : null),
      jvm: connected ? (latest?.report.jvm ?? null) : null,
      game: connected ? (latest?.report.game ?? null) : null,
      proxy: connected ? (latest?.report.proxy ?? null) : null,
      commands: this.agents.commands(id),
    };
  }

  /** Orders for a server's agent: "gc" frees memory, "evacuate" moves its players to another server (through the proxy's agent). */
  agentCommand(id: string, type: string, args: Record<string, unknown> = {}): string {
    const cfg = this.config.servers.find((s) => s.id === id);
    if (!cfg) throw new Error(`Unknown server "${id}"`);
    if (type === 'gc') {
      if (!this.agents.connected(id)) throw new Error(`The agent of "${id}" is not connected`);
      return this.agents.enqueue(id, 'gc');
    }
    if (type === 'evacuate') {
      if (cfg.role !== 'backend') throw new Error('Only a game server can be evacuated');
      const to = typeof args.to === 'string' ? args.to : this.config.servers.find((s) => s.entry && s.id !== id)?.id;
      if (!to || !this.config.servers.some((s) => s.id === to && s.role === 'backend')) throw new Error('Choose another game server to move the players to');
      if (to === id) throw new Error('The target must be a different server');
      const proxy = proxyOf(this.config);
      if (!proxy || !this.agents.connected(proxy.id)) throw new Error('The proxy agent is not connected, so players cannot be moved');
      return this.agents.enqueue(proxy.id, 'evacuate', { from: id, to, message: typeof args.message === 'string' ? args.message.slice(0, 200) : 'This server is restarting. You are being moved.' });
    }
    throw new Error(`Unknown command "${type}"`);
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

  /** Records a new port for a server and brings the proxy's server list up to date (the files were changed by the caller). */
  async setPort(id: string, port: number): Promise<ServerView> {
    const cfg = this.config.servers.find((s) => s.id === id);
    if (!cfg) throw new Error(`Unknown server "${id}"`);
    cfg.port = port;
    saveConfig(this.dataDir, this.config);
    await this.syncProxy();
    if (cfg.role === 'proxy') await this.access.refresh(); // the router forwards the new port from now on
    this.emit('servers');
    return this.view(id);
  }

  /** Removes a server from the network. Its folder and world stay on disk. */
  async removeServer(id: string): Promise<void> {
    const inst = this.instance(id);
    if (inst.status && inst.status.state !== 'stopped') throw new Error('Stop the server before removing it');
    await inst.disconnect();
    this.instances.delete(id);
    this.agents.forget(id);
    this.agentErrors.delete(id);
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

  /** Looks into an existing folder (through MCLI) and says whether and how it can join the network. Changes nothing. */
  async inspectImport(path: string): Promise<ImportReport> {
    const dir = resolve(path);
    const found = await this.lookup<Omit<ImportReport, 'support' | 'issues' | 'suggestedId'>>('inspect', { dir });
    const issues: string[] = [];
    const type = found.software?.type;
    const support: ImportSupport = !type ? 'none' : type === 'paper' ? 'full' : type === 'spigot' ? 'convert' : type === 'velocity' ? 'proxy' : 'standalone';
    if (!found.exists) issues.push('This folder does not exist.');
    else if (!found.isDirectory) issues.push('This is a file, not a folder.');
    else if (!found.software) issues.push('No Minecraft server was found in this folder.');
    const same = this.config.servers.find((s) => resolveServerDir(this.dataDir, s) === dir);
    if (same) issues.push(`This folder is already the server "${same.id}" in this network.`);
    const rel = relative(dir, resolve(this.dataDir));
    if (found.isDirectory && !same && (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)))) issues.push('This folder contains the MCNetwork data folder. Choose the server folder itself.');
    if (found.software && support !== 'none') {
      const port = found.properties?.port ?? (type === 'velocity' ? 25565 : 25565);
      if (!same && (await isListening(port))) issues.push(`Something is listening on port ${port}, probably this server. Stop it first, then import.`);
    }
    const base = basename(dir).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28) || 'server';
    let suggestedId = base;
    for (let i = 2; this.config.servers.some((s) => s.id === suggestedId); i++) suggestedId = `${base}-${i}`;
    return { ...found, support, issues, suggestedId };
  }

  /** Per server: is the heap too big, too small or right, judged by what the plugins measured over the last 24 hours. */
  recommendations(): Recommendation[] {
    return recommend(this.tracker.history(24 * 60, 100_000), this.config.servers.map((s) => s.id));
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
      const a = this.agents.connected(s.id, now) ? this.agents.latest(s.id)?.report : undefined;
      servers[s.id] = {
        state: st?.state ?? 'stopped',
        rssMb,
        maxMb: st ? parseMemoryMb(st.memory.max) : 0,
        players: st?.players.count ?? 0,
        heapUsedMb: a ? Math.round(a.jvm.heapUsedMb) : null,
        liveSetMb: a?.jvm.liveSetMb !== undefined && a.jvm.liveSetMb !== null ? Math.round(a.jvm.liveSetMb) : null,
        tps: a?.game ? Math.round(a.game.tps[0] * 10) / 10 : null,
      };
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
