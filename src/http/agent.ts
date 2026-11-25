import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { parseReport, ReportError } from '../agent/protocol';
import type { Network } from '../network';
import { HttpError, readBody } from './router';

const sha = (s: string): Buffer => createHash('sha256').update(s).digest();

/**
 * POST /api/agent/report: the plugins' reports. They authenticate with the agent token (not the
 * dashboard token), and the answer carries the orders for that server.
 */
export async function handleAgentReport(net: Network, req: IncomingMessage): Promise<unknown> {
  if (!net.config.agent.enabled) throw new HttpError(404, 'Not found');
  const given = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
  if (!timingSafeEqual(sha(given), sha(net.config.agent.token))) throw new HttpError(401, 'Wrong agent token');
  const body = await readBody(req);
  let report;
  try {
    report = parseReport(body);
  } catch (err) {
    if (err instanceof ReportError) throw new HttpError(400, err.message);
    throw err;
  }
  if (!net.config.servers.some((s) => s.id === report.serverId)) throw new HttpError(404, `This network has no server "${report.serverId}"`);
  return { ok: true, commands: net.agents.submit(report) };
}
