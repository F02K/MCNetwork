import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseMemoryMb, type McliStatus } from './protocol';

export type Connection = 'offline' | 'connecting' | 'online' | 'failed';

export interface InstanceOptions {
  /** Folder of the Minecraft server (MCLI runs here). */
  dir: string;
  mcliPath: string;
  nodePath?: string;
  /** Poll interval for the full status. */
  statusMs?: number;
  requestTimeoutMs?: number;
  /** Delay before MCLI is started again after it died unexpectedly. */
  respawnMs?: number;
  maxRespawns?: number;
  /** How long a graceful shutdown may take before MCLI is killed. */
  stopTimeoutMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface Message {
  id?: number | string | null;
  ok?: boolean;
  result?: unknown;
  error?: string;
  event?: string;
  data?: unknown;
}

const STDERR_LINES = 50;

/**
 * One MCLI process (`mcli --api`) that manages one Minecraft server.
 * Events: 'event' (name, data) for everything MCLI reports, 'status' (McliStatus),
 * 'connection' (Connection), 'stderr' (line).
 */
export class McliInstance extends EventEmitter {
  connection: Connection = 'offline';
  status: McliStatus | null = null;
  lastError: string | null = null;
  /** Heap (MB) the running server was started with, as configured when it last started. */
  activeMaxMb: number | null = null;
  /** The last lines MCLI wrote to stderr (crash reasons end up here). */
  readonly stderrTail: string[] = [];
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private poll: NodeJS.Timeout | null = null;
  private respawnTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private respawns = 0;
  private connectedAt = 0;

  constructor(
    readonly id: string,
    private opts: InstanceOptions,
  ) {
    super();
  }

  private setConnection(c: Connection): void {
    if (this.connection === c) return;
    this.connection = c;
    this.emit('connection', c);
  }

  /** Starts MCLI and resolves when it announced itself (rejects on failure or timeout). */
  connect(): Promise<void> {
    if (this.child) return Promise.resolve();
    this.stopping = false;
    this.setConnection('connecting');
    mkdirSync(this.opts.dir, { recursive: true });
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.off('event', onEvent);
        this.off('exit-early', onEarly);
        if (err) {
          this.lastError = err.message;
          reject(err);
        } else resolve();
      };
      const onEvent = (name: string) => {
        if (name === 'ready') done();
      };
      const onEarly = (err: Error) => done(err);
      const timer = setTimeout(() => done(new Error('MCLI did not start in time')), this.opts.requestTimeoutMs ?? 10_000);
      this.on('event', onEvent);
      this.on('exit-early', onEarly);
      this.spawnChild();
    }).then(async () => {
      this.connectedAt = Date.now();
      this.setConnection('online');
      await this.refresh();
      this.poll = setInterval(() => void this.refresh().catch(() => undefined), this.opts.statusMs ?? 5000);
      this.poll.unref();
    });
  }

  private spawnChild(): void {
    const child = spawn(this.opts.nodePath ?? process.execPath, [this.opts.mcliPath, '--api'], { cwd: this.opts.dir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line));
    createInterface({ input: child.stderr }).on('line', (line) => {
      this.stderrTail.push(line);
      if (this.stderrTail.length > STDERR_LINES) this.stderrTail.shift();
      this.emit('stderr', line);
    });
    child.stdin.on('error', () => undefined); // a dead child is handled by 'exit'
    child.on('error', (err) => this.onExit(child, null, `could not start MCLI: ${err.message}`));
    child.on('exit', (code, signal) => this.onExit(child, code, signal ? `killed by ${signal}` : `exit code ${code}`));
  }

  private onLine(line: string): void {
    let msg: Message;
    try {
      msg = JSON.parse(line) as Message;
    } catch {
      this.emit('stderr', `[unparsable stdout] ${line}`);
      return;
    }
    if (msg.event) {
      if (msg.event === 'state' && (msg.data as { state?: string } | undefined)?.state === 'starting') this.noteStart();
      this.emit('event', msg.event, msg.data);
      if (msg.event === 'state') void this.refresh().catch(() => undefined);
      return;
    }
    if (typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error ?? 'request failed'));
  }

  /** Remembers the configured heap when a start begins, to tell later that a restart is needed. */
  private noteStart(): void {
    const max = this.status?.memory.max;
    if (max) this.activeMaxMb = parseMemoryMb(max);
  }

  private onExit(child: ChildProcessWithoutNullStreams, _code: number | null, reason: string): void {
    if (this.child !== child) return;
    this.child = null;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(`MCLI ended (${reason})`));
    }
    this.pending.clear();
    this.status = this.status ? { ...this.status, state: 'stopped', pid: null } : null;
    this.activeMaxMb = null;
    const wasOnline = this.connection === 'online';
    if (this.stopping) {
      this.setConnection('offline');
      return;
    }
    this.lastError = `MCLI ended unexpectedly (${reason})`;
    if (!wasOnline) {
      this.setConnection('failed');
      this.emit('exit-early', new Error(this.lastError));
      return;
    }
    this.scheduleRespawn();
  }

  private scheduleRespawn(): void {
    if (Date.now() - this.connectedAt > 60_000) this.respawns = 0; // it ran for a while: not a crash loop
    if (this.respawns >= (this.opts.maxRespawns ?? 3)) {
      this.setConnection('failed');
      return;
    }
    this.respawns++;
    this.setConnection('connecting');
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null;
      this.connect()
        .then(() => this.emit('respawned'))
        .catch(() => this.scheduleRespawn());
    }, this.opts.respawnMs ?? 3000);
  }

  /** Sends one request; resolves with the result or rejects with MCLI's error text. */
  request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    const child = this.child;
    if (!child) return Promise.reject(new Error(`MCLI for "${this.id}" is not running`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs ?? this.opts.requestTimeoutMs ?? 10_000);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  /** Fetches the full status and emits 'status'. */
  async refresh(): Promise<McliStatus> {
    const status = await this.request<McliStatus>('status');
    this.status = status;
    if (status.state === 'stopped') this.activeMaxMb = null;
    else this.activeMaxMb ??= parseMemoryMb(status.memory.max);
    this.emit('status', status);
    return status;
  }

  /** True when the heap in mcli.json differs from the one the running server started with. */
  get needsRestart(): boolean {
    const max = this.status?.memory.max;
    return this.status?.state !== 'stopped' && this.activeMaxMb !== null && !!max && parseMemoryMb(max) !== this.activeMaxMb;
  }

  /** Stops the Minecraft server and MCLI gracefully; kills MCLI when that takes too long. */
  async disconnect(): Promise<void> {
    this.stopping = true;
    if (this.respawnTimer) clearTimeout(this.respawnTimer);
    this.respawnTimer = null;
    const child = this.child;
    if (!child) return this.setConnection('offline');
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.stdin.end(); // MCLI stops the server gracefully when its input closes
    const kill = setTimeout(() => child.kill('SIGKILL'), this.opts.stopTimeoutMs ?? 45_000);
    await exited;
    clearTimeout(kill);
  }
}
