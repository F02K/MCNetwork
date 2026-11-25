import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ID_RE, resolveServerDir } from '../config';
import type { McliInstance } from '../mcli/instance';
import type { Network } from '../network';
import type { MemorySettings, ServerConfig } from '../types';
import { BACKEND_HOST, PAPER_GLOBAL, prepareBackendFiles, proxyOf, readForwardingSecret, VELOCITY_TOML, writeBackendForwarding, writeProxyConfig } from './layout';
import { allocatePorts, PROXY_PORT } from './ports';

export interface SetupBackend {
  id: string;
  name?: string;
  /** Paper version; empty = newest. */
  version?: string;
  memory?: MemorySettings;
  /** Players join this one first (default: the first backend). */
  entry?: boolean;
}

export interface SetupRequest {
  proxy: { version?: string; port?: number; motd?: string };
  backends: SetupBackend[];
  ram?: { reserveMb?: number };
  /** The user accepts the Minecraft EULA (https://aka.ms/MinecraftEULA) for the backend servers. */
  acceptEula: boolean;
  /** Start the network when everything is ready. */
  start?: boolean;
}

export type StepStatus = 'pending' | 'running' | 'done' | 'failed';

export interface SetupStep {
  id: string;
  label: string;
  status: StepStatus;
  detail?: string;
}

export interface SetupState {
  id: number;
  status: 'running' | 'done' | 'failed';
  startedAt: number;
  steps: SetupStep[];
  error?: string;
}

const obj = (v: unknown, what: string): Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`"${what}" must be an object`);
  return v as Record<string, unknown>;
};

const optStr = (v: unknown, what: string): string | undefined => {
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string') throw new Error(`"${what}" must be a string`);
  return v;
};

/** Paper only has config/paper-global.yml (with the proxy settings we write) from Minecraft 1.19 on. */
export function paperSupported(version: string): boolean {
  const m = /^1\.(\d+)/.exec(version);
  return !m || Number(m[1]) >= 19;
}

/** Checks the wizard input; throws an Error that tells the user what to change. */
export function parseSetupRequest(input: unknown, existingIds: string[], hasProxy = false): SetupRequest {
  const body = obj(input, 'request');
  if (body.acceptEula !== true) throw new Error('The Minecraft EULA (https://aka.ms/MinecraftEULA) must be accepted to set up game servers');
  const proxy = obj(body.proxy ?? {}, 'proxy');
  const port = proxy.port === undefined ? undefined : proxy.port;
  if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('"proxy.port" must be a whole number from 1 to 65535');
  if (!Array.isArray(body.backends) || !body.backends.length) throw new Error('Add at least one game server');
  const seen = new Set<string>(hasProxy ? [] : ['proxy']);
  const backends = body.backends.map((raw, i): SetupBackend => {
    const b = obj(raw, `backends[${i}]`);
    if (typeof b.id !== 'string' || !ID_RE.test(b.id)) throw new Error(`backends[${i}].id must be 1-32 characters: lowercase letters, digits, "-" or "_"`);
    if (seen.has(b.id)) throw new Error(`The server id "${b.id}" is used twice (or reserved)`);
    seen.add(b.id);
    const version = optStr(b.version, `backends[${i}].version`);
    if (version && !paperSupported(version)) throw new Error(`Paper ${version} is too old: the network needs Paper 1.19 or newer`);
    return { id: b.id, name: optStr(b.name, `backends[${i}].name`), version, memory: b.memory as MemorySettings | undefined, entry: b.entry === true };
  });
  for (const id of seen) if (existingIds.includes(id)) throw new Error(`A server "${id}" already exists in this network`);
  const ram = body.ram === undefined ? undefined : obj(body.ram, 'ram');
  return {
    proxy: { version: optStr(proxy.version, 'proxy.version'), port, motd: optStr(proxy.motd, 'proxy.motd') },
    backends,
    ram: ram ? { reserveMb: typeof ram.reserveMb === 'number' ? ram.reserveMb : undefined } : undefined,
    acceptEula: true,
    start: body.start !== false,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface SetupOptions {
  /** Test hooks. */
  pollMs?: number;
  bootstrapTimeoutMs?: number;
  isPortFree?: (port: number) => Promise<boolean>;
}

/**
 * Builds a network from the wizard's answers: creates the servers, installs the software, lets each
 * server write its default config once, then connects them (ports, forwarding secret, server list).
 * Emits 'change' (SetupState) after every step change.
 */
export class SetupRunner extends EventEmitter {
  state: SetupState | null = null;
  private counter = 0;

  constructor(
    private net: Network,
    private opts: SetupOptions = {},
  ) {
    super();
  }

  get running(): boolean {
    return this.state?.status === 'running';
  }

  /** Validates the request and starts the job in the background. */
  start(input: unknown): SetupState {
    if (this.running) throw new Error('A setup is already running');
    const hasProxy = proxyOf(this.net.config) !== undefined;
    const req = parseSetupRequest(input, this.net.config.servers.map((s) => s.id), hasProxy);
    const ids = [...(hasProxy ? [] : ['proxy']), ...req.backends.map((b) => b.id)];
    const steps: SetupStep[] = [
      { id: 'create', label: 'Create the servers', status: 'pending' },
      { id: 'ram', label: 'Plan the RAM', status: 'pending' },
      ...ids.map((id) => ({ id: `install:${id}`, label: `Install ${id === 'proxy' ? 'Velocity' : `Paper for "${id}"`}`, status: 'pending' as const })),
      ...ids.map((id) => ({ id: `prepare:${id}`, label: `First start of "${id}" (creates its settings)`, status: 'pending' as const })),
      { id: 'connect', label: 'Connect the servers to the proxy', status: 'pending' },
      ...(req.start ? [{ id: 'start', label: 'Start the network', status: 'pending' as const }] : []),
    ];
    this.state = { id: ++this.counter, status: 'running', startedAt: Date.now(), steps };
    this.emit('change', this.state);
    void this.run(req);
    return this.state;
  }

  private async step(id: string, work: () => Promise<string | void> | string | void): Promise<void> {
    const step = this.state?.steps.find((s) => s.id === id) as SetupStep;
    step.status = 'running';
    this.emit('change', this.state);
    try {
      step.detail = (await work()) ?? undefined;
      step.status = 'done';
    } catch (err) {
      step.status = 'failed';
      step.detail = (err as Error).message;
      throw err;
    } finally {
      this.emit('change', this.state);
    }
  }

  private async run(req: SetupRequest): Promise<void> {
    const state = this.state as SetupState;
    try {
      await this.execute(req);
      state.status = 'done';
    } catch (err) {
      state.status = 'failed';
      state.error = (err as Error).message;
    }
    this.emit('change', state);
  }

  private async execute(req: SetupRequest): Promise<void> {
    const { net } = this;
    const proxyPort = req.proxy.port ?? PROXY_PORT;
    const configured: ServerConfig[] = [];

    await this.step('create', async () => {
      const taken = [...net.config.servers.flatMap((s) => (s.port ? [s.port] : [])), proxyPort];
      const ports = await allocatePorts(req.backends.length, taken, undefined, this.opts.isPortFree);
      const hasProxy = proxyOf(net.config) !== undefined;
      if (!hasProxy) await net.addServer({ id: 'proxy', name: 'Proxy', role: 'proxy', port: proxyPort });
      // somebody has to be the first stop for players: the chosen server, else the first new one if none exists yet
      const hasEntry = net.config.servers.some((s) => s.entry);
      const entry = req.backends.some((b) => b.entry) || hasEntry ? undefined : req.backends[0].id;
      for (const [i, b] of req.backends.entries()) {
        await net.addServer({ id: b.id, name: b.name ?? b.id, role: 'backend', port: ports[i], memory: b.memory, entry: b.entry || b.id === entry || undefined });
      }
      configured.push(...net.config.servers.filter((s) => (s.role === 'proxy' && !hasProxy) || req.backends.some((b) => b.id === s.id)));
      return `${configured.length} servers`;
    });
    if (req.ram?.reserveMb !== undefined) net.config.ram.reserveMb = req.ram.reserveMb;

    await this.step('ram', async () => {
      const { plan, failed } = await net.applyPlan();
      if (failed.length) throw new Error(`Could not set the memory of ${failed.map((f) => f.id).join(', ')}`);
      if (plan.warnings.length) return plan.warnings[0];
      return plan.allocations.map((a) => `${a.id} ${a.xmxMb} MB`).join(', ');
    });

    const versions: Record<string, string> = {};
    for (const s of configured) {
      const backend = req.backends.find((b) => b.id === s.id);
      const provider = s.role === 'proxy' ? 'velocity' : 'paper';
      await this.step(`install:${s.id}`, async () => {
        const version = (s.role === 'proxy' ? req.proxy.version : backend?.version) || (await net.defaultVersion(provider));
        versions[s.id] = version;
        const ok = await net.instance(s.id).request<boolean>('install', { provider, version, backupFirst: false }, 600_000);
        if (!ok) throw new Error(`The download of ${provider} ${version} failed - see the log of "${s.id}"`);
        if (s.role === 'backend') await net.instance(s.id).request('acceptEula'); // the user accepted the EULA in the request
        const agent = net.ensureAgent(s.id); // the plugin must be in place before the first start
        return `${provider} ${version}${agent ? ` + agent ${agent.version}` : ' (agent plugin not installed: see the server in the dashboard)'}`;
      });
    }

    // Servers write their own default settings on the first start; those files are patched afterwards.
    for (const s of configured) {
      await this.step(`prepare:${s.id}`, async () => {
        const dir = resolveServerDir(net.dataDir, s);
        if (s.role === 'backend') prepareBackendFiles(dir, s);
        await this.bootstrap(net.instance(s.id), join(dir, s.role === 'proxy' ? VELOCITY_TOML : PAPER_GLOBAL));
      });
    }

    await this.step('connect', async () => {
      const proxy = proxyOf(net.config) as ServerConfig;
      const secret = readForwardingSecret(net.dataDir, proxy);
      if (!secret) throw new Error('Velocity did not create forwarding.secret');
      for (const s of configured.filter((c) => c.role === 'backend')) {
        if (!writeBackendForwarding(resolveServerDir(net.dataDir, s), secret)) throw new Error(`"${s.id}" did not create ${PAPER_GLOBAL}`);
      }
      if (configured.some((c) => c.role === 'proxy')) writeProxyConfig(net.dataDir, net.config, { bind: `0.0.0.0:${proxyPort}`, motd: req.proxy.motd, forwardingMode: 'modern' });
      else await net.syncProxy(); // an existing proxy learns about the new servers (and reloads if it runs)
      return `players join via ${BACKEND_HOST}`;
    });

    if (req.start) {
      await this.step('start', async () => {
        for (const s of [...configured].sort((a, b) => Number(a.role === 'proxy') - Number(b.role === 'proxy'))) await net.startServer(s.id);
      });
    }
  }

  /** Starts a server until `file` exists, then stops it again. */
  private async bootstrap(inst: McliInstance, file: string): Promise<void> {
    await inst.request('start', {}, 120_000);
    const end = Date.now() + (this.opts.bootstrapTimeoutMs ?? 180_000);
    let outcome: 'file' | 'stopped' | 'timeout' = 'timeout';
    while (Date.now() < end) {
      if (existsSync(file)) {
        outcome = 'file';
        break;
      }
      const status = await inst.refresh();
      if (status.state === 'stopped') {
        outcome = existsSync(file) ? 'file' : 'stopped';
        break;
      }
      await sleep(this.opts.pollMs ?? 500);
    }
    if (outcome !== 'file') {
      const problem = inst.status?.problems[0];
      await inst.request('stop', {}, 60_000).catch(() => undefined);
      throw new Error(outcome === 'stopped' ? `The server stopped before it wrote its settings${problem ? `: ${problem.title}. ${problem.advice}` : ''}` : 'The server did not write its settings in time');
    }
    await sleep(this.opts.pollMs ?? 500); // let the server finish writing the file
    await inst.request('stop', {}, 60_000);
    await inst.refresh();
  }
}
