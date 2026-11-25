import { EventEmitter } from 'node:events';
import type { Network } from '../network';
import { detectLeak, versionAtLeast } from './rules';

/** The proxy plugin needs this version to hold players and connect them after a server was woken up. */
export const WAKE_AGENT_VERSION = '0.2.0';

export type AutopilotAction = 'free-memory' | 'stop-idle' | 'wake' | 'ready' | 'restart-leak' | 'evacuate' | 'blocked';

export interface AutopilotEvent {
  t: number;
  action: AutopilotAction;
  server: string | null;
  reason: string;
  /** Only written down, nothing was done. */
  dryRun: boolean;
  /** null for a dry run and for notes; otherwise whether the action worked. */
  ok: boolean | null;
  error?: string;
}

export interface AutopilotOptions {
  now?: () => number;
  /** Real actions per hour before it holds back (protects against a flapping rule). */
  maxActionsPerHour?: number;
  /** A server must have run this long before it can be stopped for being idle (it may just have been woken up). */
  minUptimeMs?: number;
}

const HOUR = 3_600_000;
const KEEP_EVENTS = 200;
const AWAKE_FOR_MS = 120_000;
const WAKE_TIMEOUT_MS = 5 * 60_000;
const RESTART_COOLDOWN_MS = 6 * HOUR;
const GC_COOLDOWN_MS = 5 * 60_000;
const SAME_NOTE_MS = 30 * 60_000;

/**
 * Takes care of routine things by itself: frees memory when the machine gets tight, stops servers nobody is on
 * (and starts them when a player asks), and restarts a server whose memory need keeps growing. Every rule can be
 * switched off, the whole thing is off and in "dry run" by default, and it never touches a server with players.
 * Emits 'event' (AutopilotEvent).
 */
export class Autopilot extends EventEmitter {
  readonly events: AutopilotEvent[] = [];
  /** Servers it stopped because they were empty: name -> since. */
  readonly sleeping = new Map<string, number>();
  private waking = new Map<string, number>();
  private awake = new Map<string, number>();
  private emptySince = new Map<string, number>();
  private lastGc = new Map<string, number>();
  private lastRestart = new Map<string, number>();
  private planned = new Set<string>();
  private evacuated = new Set<string>();
  private lastNote = new Map<string, number>();
  private actions: number[] = [];
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly now: () => number;
  private readonly maxActions: number;
  private readonly minUptimeMs: number;

  constructor(
    private net: Network,
    opts: AutopilotOptions = {},
  ) {
    super();
    this.now = opts.now ?? Date.now;
    this.maxActions = opts.maxActionsPerHour ?? 12;
    this.minUptimeMs = opts.minUptimeMs ?? 120_000;
  }

  start(): void {
    this.schedule();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** (Re)starts the timer with the configured interval. */
  schedule(): void {
    this.stop();
    this.timer = setInterval(() => void this.tick(), this.net.config.autopilot.intervalSeconds * 1000);
    this.timer.unref();
  }

  // ------------------------------------------------------------ bookkeeping

  private push(ev: AutopilotEvent): void {
    this.events.push(ev);
    if (this.events.length > KEEP_EVENTS) this.events.splice(0, this.events.length - KEEP_EVENTS);
    this.emit('event', ev);
  }

  /** A remark ("blocked because ..."), written at most once in a while per subject. */
  private note(action: AutopilotAction, server: string | null, reason: string, key = `${action}:${server}:${reason}`): void {
    const now = this.now();
    if (now - (this.lastNote.get(key) ?? 0) < SAME_NOTE_MS) return;
    this.lastNote.set(key, now);
    this.push({ t: now, action, server, reason, dryRun: false, ok: null });
  }

  /** Does `fn` - or only records it in dry-run mode. Returns false when it failed or was held back. */
  private async act(action: AutopilotAction, server: string, reason: string, fn: () => unknown): Promise<boolean> {
    const cfg = this.net.config.autopilot;
    const now = this.now();
    const ev: AutopilotEvent = { t: now, action, server, reason, dryRun: cfg.dryRun, ok: null };
    if (cfg.dryRun) {
      const key = `dry:${action}:${server}`;
      if (now - (this.lastNote.get(key) ?? 0) < SAME_NOTE_MS) return false;
      this.lastNote.set(key, now);
      this.push(ev);
      return false;
    }
    this.actions = this.actions.filter((t) => now - t < HOUR);
    if (this.actions.length >= this.maxActions) {
      this.note('blocked', server, `Held back: ${this.maxActions} automatic actions in the last hour already.`, 'rate');
      return false;
    }
    this.actions.push(now);
    try {
      await fn();
      ev.ok = true;
    } catch (err) {
      ev.ok = false;
      ev.error = (err as Error).message;
    }
    this.push(ev);
    return ev.ok;
  }

  // ------------------------------------------------------------ what is going on

  private playersOn(id: string): number {
    const v = this.net.view(id);
    return Math.max(v.status?.players.count ?? 0, v.agent.connected ? (v.agent.game?.players ?? 0) : 0);
  }

  private running_(id: string): boolean {
    return this.net.view(id).status?.state === 'running';
  }

  /** Names the proxy plugin should hold players for, and those that are ready now. Only while the feature really works. */
  lists(): { sleeping: string[]; awake: string[] } {
    const cfg = this.net.config.autopilot;
    const now = this.now();
    for (const [name, until] of this.awake) if (until < now) this.awake.delete(name);
    if (!cfg.enabled || cfg.dryRun || !cfg.wakeOnDemand) return { sleeping: [], awake: [] };
    return { sleeping: [...new Set([...this.sleeping.keys(), ...this.waking.keys()])], awake: [...this.awake.keys()] };
  }

  /** Whether the proxy's plugin can hold players for sleeping servers. */
  get wakeSupported(): boolean {
    const proxy = this.net.config.servers.find((s) => s.role === 'proxy');
    if (!proxy) return false;
    const a = this.net.agentView(proxy.id);
    return a.connected && versionAtLeast(a.version, WAKE_AGENT_VERSION);
  }

  state() {
    return { config: this.net.config.autopilot, events: [...this.events].reverse(), sleeping: [...this.sleeping].map(([name, since]) => ({ name, since })), waking: [...this.waking.keys()], wakeSupported: this.wakeSupported };
  }

  // ------------------------------------------------------------ waking

  /** A player wants to join a server that was stopped for being idle: start it (the proxy plugin holds the player). */
  async wake(name: string): Promise<boolean> {
    if (!this.sleeping.has(name) || this.waking.has(name)) return false;
    this.waking.set(name, this.now());
    this.emptySince.delete(name);
    const ok = await this.act('wake', name, 'a player wants to join', () => this.net.startServer(name));
    if (!ok) this.waking.delete(name);
    return ok;
  }

  // ------------------------------------------------------------ the check

  /** One round. Public so that tests can drive it with their own clock. */
  async tick(now = this.now()): Promise<void> {
    const cfg = this.net.config.autopilot;
    if (!cfg.enabled || this.running || this.net.setup.running) return;
    this.running = true;
    try {
      this.follow(now);
      await this.freeMemory(now);
      await this.stopIdle(now);
      await this.restartLeaking(now);
    } finally {
      this.running = false;
    }
  }

  /** Keeps track of who is empty since when, and of servers that were woken up. */
  private follow(now: number): void {
    const backends = this.net.config.servers.filter((s) => s.role === 'backend');
    for (const s of backends) {
      if (this.running_(s.id) && this.playersOn(s.id) === 0) {
        if (!this.emptySince.has(s.id)) this.emptySince.set(s.id, now);
      } else this.emptySince.delete(s.id);
      if (this.sleeping.has(s.id) && !this.waking.has(s.id) && this.running_(s.id)) this.sleeping.delete(s.id); // somebody started it
    }
    for (const [name, since] of this.waking) {
      const status = this.net.view(name).status;
      if (status?.state === 'running' && status.health.reachable === true) {
        this.waking.delete(name);
        this.sleeping.delete(name);
        this.awake.set(name, now + AWAKE_FOR_MS);
        this.push({ t: now, action: 'ready', server: name, reason: 'it answers; waiting players are sent there', dryRun: false, ok: true });
      } else if (now - since > WAKE_TIMEOUT_MS) {
        this.waking.delete(name);
        this.push({ t: now, action: 'wake', server: name, reason: 'it did not come up in 5 minutes', dryRun: false, ok: false, error: 'timeout' });
      }
    }
  }

  private async freeMemory(now: number): Promise<void> {
    const cfg = this.net.config.autopilot;
    const frame = this.net.tracker.latest;
    if (!cfg.gcOnPressure || !frame || frame.pressure === 'ok') return;
    const pct = Math.round((frame.system.availableMb / Math.max(1, frame.system.totalMb)) * 100);
    for (const s of this.net.config.servers) {
      if (!this.running_(s.id) || !this.net.agents.connected(s.id) || now - (this.lastGc.get(s.id) ?? 0) < GC_COOLDOWN_MS) continue;
      this.lastGc.set(s.id, now);
      await this.act('free-memory', s.id, `memory is ${frame.pressure === 'critical' ? 'critically low' : 'getting low'} (${pct} % available)`, () => this.net.agentCommand(s.id, 'gc'));
    }
  }

  private async stopIdle(now: number): Promise<void> {
    const cfg = this.net.config.autopilot;
    if (!cfg.stopIdle) return;
    const pressure = this.net.tracker.latest?.pressure ?? 'ok';
    const minutes = pressure === 'ok' ? cfg.idleMinutes : Math.max(2, Math.floor(cfg.idleMinutes / 5));
    for (const s of this.net.config.servers) {
      if (s.role !== 'backend' || s.standalone || s.entry) continue; // the proxy sends everybody to the join-first server: it stays
      const since = this.emptySince.get(s.id);
      const view = this.net.view(s.id);
      if (since === undefined || now - since < minutes * 60_000 || (view.status?.uptimeMs ?? 0) < this.minUptimeMs) continue;
      if (this.playersOn(s.id) > 0) continue;
      if (cfg.wakeOnDemand && !this.wakeSupported) {
        this.note('blocked', s.id, `Not stopped: waking servers on demand needs the proxy plugin ${WAKE_AGENT_VERSION} or newer to report (restart the proxy after updating).`, 'wake-support');
        continue;
      }
      const ok = await this.act('stop-idle', s.id, `nobody was on it for ${minutes} minutes${pressure === 'ok' ? '' : ' and memory is tight'}`, async () => {
        await this.net.instance(s.id).request('stop', {}, 120_000);
        this.emptySince.delete(s.id); // when it runs again, the idle time starts from zero
        if (cfg.wakeOnDemand) this.sleeping.set(s.id, now);
      });
      if (ok) return; // one at a time
    }
  }

  private async restartLeaking(now: number): Promise<void> {
    const cfg = this.net.config.autopilot;
    if (!cfg.restartOnLeak) return;
    const frames = this.net.tracker.history(3 * 60, 100_000, now);
    for (const s of this.net.config.servers) {
      if (s.role !== 'backend' || !this.running_(s.id)) {
        this.planned.delete(s.id);
        continue;
      }
      if (now - (this.lastRestart.get(s.id) ?? 0) < RESTART_COOLDOWN_MS) continue;
      const verdict = detectLeak(frames, s.id, { now });
      if (!this.planned.has(s.id)) {
        if (!verdict.leaking) continue;
        this.planned.add(s.id);
        this.note('restart-leak', s.id, `Restart planned when nobody is on it: ${verdict.reason}`);
      }
      const players = this.playersOn(s.id);
      if (players > 0) {
        if (verdict.liveMb >= verdict.maxMb * 0.9 && !this.evacuated.has(s.id)) {
          this.evacuated.add(s.id);
          await this.act('evacuate', s.id, `the heap is nearly full of data that is not released; ${players} player(s) are moved to another server`, () => this.net.agentCommand(s.id, 'evacuate'));
        }
        continue;
      }
      this.planned.delete(s.id);
      this.evacuated.delete(s.id);
      this.lastRestart.set(s.id, now);
      await this.act('restart-leak', s.id, verdict.reason, () => this.net.instance(s.id).request('restart', {}, 240_000));
    }
  }
}
