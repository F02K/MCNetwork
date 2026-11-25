import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { AgentCommandOut, AgentReport, CommandResult } from './protocol';

/** An agent counts as connected while its reports keep coming (the plugins report every 10 s by default). */
export const CONNECTED_MS = 45_000;
const KEEP_RESULTS = 20;

export interface PendingCommand extends CommandResult {
  type: string;
  at: number;
  /** false until the agent reported the outcome. */
  done: boolean;
}

/**
 * The latest report of every agent, and the orders waiting for them. Orders are handed out with
 * the answer to the agent's next report; the outcome comes back with the report after that.
 * Emits 'report' (AgentReport).
 */
export class AgentStore extends EventEmitter {
  private reports = new Map<string, { report: AgentReport; receivedAt: number }>();
  private queue = new Map<string, AgentCommandOut[]>();
  private history = new Map<string, PendingCommand[]>();

  /** Stores a report and returns the orders for this agent. */
  submit(report: AgentReport, now = Date.now()): AgentCommandOut[] {
    this.reports.set(report.serverId, { report, receivedAt: now });
    const log = this.history.get(report.serverId) ?? [];
    for (const r of report.results) {
      const entry = log.find((c) => c.id === r.id);
      if (entry) Object.assign(entry, { ok: r.ok, message: r.message, done: true });
    }
    const orders = this.queue.get(report.serverId) ?? [];
    this.queue.delete(report.serverId);
    this.emit('report', report);
    return orders;
  }

  /** Queues an order; it is delivered with the agent's next report. Returns its id. */
  enqueue(serverId: string, type: AgentCommandOut['type'], args: Record<string, unknown> = {}): string {
    const id = randomBytes(6).toString('hex');
    this.queue.set(serverId, [...(this.queue.get(serverId) ?? []), { id, type, ...args }]);
    const log = this.history.get(serverId) ?? [];
    log.push({ id, type, at: Date.now(), ok: false, message: '', done: false });
    this.history.set(serverId, log.slice(-KEEP_RESULTS));
    return id;
  }

  latest(serverId: string): { report: AgentReport; receivedAt: number } | null {
    return this.reports.get(serverId) ?? null;
  }

  connected(serverId: string, now = Date.now()): boolean {
    const r = this.reports.get(serverId);
    return !!r && now - r.receivedAt < CONNECTED_MS;
  }

  commands(serverId: string): PendingCommand[] {
    return [...(this.history.get(serverId) ?? [])].reverse();
  }

  forget(serverId: string): void {
    this.reports.delete(serverId);
    this.queue.delete(serverId);
    this.history.delete(serverId);
  }
}
