import type { Network } from '../network';
import { changePort, portOverview } from '../ports/manager';
import { HttpError, type Route } from './router';

function str(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== 'string' || !v) throw new HttpError(400, `"${key}" (string) is required`);
  return v;
}

/** Turns "Unknown server" style errors into 404 and everything else MCLI rejects into 400. */
async function guarded<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const message = (err as Error).message;
    throw new HttpError(/^Unknown server/.test(message) ? 404 : 400, message);
  }
}

/** Forwards one call to the server's MCLI. */
const forward = (net: Network, method: string, params: (body: Record<string, unknown>) => Record<string, unknown> = () => ({}), timeoutMs?: number) =>
  ({ params: p, body }: { params: Record<string, string>; body: Record<string, unknown> }) =>
    guarded(() => net.instance(p.id).request(method, params(body), timeoutMs));

export function buildRoutes(net: Network): Route[] {
  const id = '/api/servers/:id';
  return [
    { method: 'GET', path: '/api/network', handler: () => ({ servers: net.views(), ram: net.tracker.latest, plan: net.plan() }) },

    { method: 'GET', path: '/api/servers', handler: () => net.views() },
    { method: 'POST', path: '/api/servers', handler: ({ body }) => guarded(() => net.addServer(body)) },
    { method: 'GET', path: id, handler: ({ params }) => guarded(() => net.view(params.id)) },
    { method: 'PUT', path: id, handler: ({ params, body }) => guarded(() => net.updateServer(params.id, body)) },
    { method: 'DELETE', path: id, handler: ({ params }) => guarded(async () => (await net.removeServer(params.id), { removed: params.id })) },

    { method: 'POST', path: `${id}/start`, handler: forward(net, 'start', () => ({}), 120_000) },
    { method: 'POST', path: `${id}/stop`, handler: forward(net, 'stop', () => ({}), 120_000) },
    { method: 'POST', path: `${id}/restart`, handler: forward(net, 'restart', () => ({}), 240_000) },
    { method: 'POST', path: `${id}/backup`, handler: forward(net, 'backup', () => ({}), 600_000) },
    { method: 'POST', path: `${id}/command`, handler: forward(net, 'command', (b) => ({ text: str(b, 'text') })) },
    { method: 'POST', path: `${id}/eula`, handler: forward(net, 'acceptEula') },
    {
      method: 'POST',
      path: `${id}/install`,
      handler: async (ctx) => {
        const ok = await forward(net, 'install', (b) => ({ provider: str(b, 'provider'), version: str(b, 'version'), backupFirst: b.backupFirst }), 600_000)(ctx);
        if (ok === true) net.ensureAgent(ctx.params.id); // new software: the agent plugin goes with it
        return ok;
      },
    },
    { method: 'POST', path: `${id}/update`, handler: forward(net, 'update', (b) => ({ latest: b.latest === true }), 600_000) },
    { method: 'GET', path: `${id}/versions`, handler: ({ params, query }) => guarded(() => net.instance(params.id).request('versions', { provider: query.get('provider') ?? 'paper', snapshots: query.get('snapshots') === 'true' }, 30_000)) },
    { method: 'GET', path: `${id}/logs`, handler: ({ params, query }) => guarded(() => net.instance(params.id).request('logs', { limit: Number(query.get('limit') ?? 200) })) },
    { method: 'GET', path: `${id}/players`, handler: forward(net, 'players') },
    { method: 'GET', path: `${id}/settings`, handler: forward(net, 'settings') },

    { method: 'POST', path: '/api/import/inspect', handler: ({ body }) => guarded(() => net.inspectImport(str(body, 'path'))) },
    { method: 'GET', path: '/api/setup', handler: () => net.setup.state },
    { method: 'POST', path: '/api/setup', handler: ({ body }) => guarded(() => net.setup.start(body)) },
    {
      method: 'GET',
      path: '/api/setup/defaults',
      handler: () =>
        guarded(async () => {
          const [paper, velocity] = await Promise.all([net.versionChoices('paper'), net.versionChoices('velocity')]);
          const plan = net.plan();
          return { paper, velocity, ports: { proxy: 25565 }, ram: { totalMb: plan.totalMb, reserveMb: plan.reserveMb }, configured: net.config.servers.length > 0 };
        }),
    },

    { method: 'GET', path: '/api/autopilot', handler: () => net.autopilot.state() },
    { method: 'PUT', path: '/api/autopilot', handler: ({ body }) => guarded(() => net.updateAutopilot(body)) },
    { method: 'POST', path: '/api/autopilot/wake', handler: ({ body }) => guarded(async () => ({ started: await net.autopilot.wake(str(body, 'server')) })) },
    { method: 'POST', path: '/api/shutdown', handler: () => (net.requestShutdown(), { stopping: true }) },
    { method: 'GET', path: '/api/ports', handler: () => guarded(() => portOverview(net)) },
    {
      method: 'POST',
      path: `${id}/port`,
      handler: ({ params, body }) => guarded(() => changePort(net, params.id, { port: body.port === undefined ? undefined : Number(body.port), localOnly: body.localOnly === true })),
    },
    { method: 'GET', path: '/api/ports/access', handler: () => guarded(() => net.access.info()) },
    { method: 'POST', path: '/api/ports/upnp/discover', handler: () => guarded(() => net.access.discover()) },
    { method: 'POST', path: '/api/ports/upnp/open', handler: () => guarded(() => net.access.open()) },
    { method: 'POST', path: '/api/ports/upnp/close', handler: () => guarded(async () => (await net.access.close(), { closed: true })) },
    {
      method: 'POST',
      path: '/api/ports/check',
      // sends the public address and port to an outside service: only with an explicit "confirm"
      handler: ({ body }) => guarded(() => (body.confirm === true ? net.access.check() : Promise.reject(new HttpError(400, 'This sends your public address and port to an outside service. Send {"confirm": true} to go ahead.')))),
    },
    { method: 'GET', path: '/api/agent', handler: () => ({ enabled: net.config.agent.enabled, bundledVersion: net.bundledAgentVersion }) },
    { method: 'POST', path: `${id}/agent/install`, handler: ({ params }) => guarded(() => net.installAgent(params.id)) },
    { method: 'POST', path: `${id}/agent/command`, handler: ({ params, body }) => guarded(() => ({ id: net.agentCommand(params.id, str(body, 'type'), body) })) },
    { method: 'POST', path: `${id}/gc`, handler: ({ params }) => guarded(() => ({ id: net.agentCommand(params.id, 'gc') })) },
    { method: 'POST', path: `${id}/evacuate`, handler: ({ params, body }) => guarded(() => ({ id: net.agentCommand(params.id, 'evacuate', body) })) },
    { method: 'GET', path: '/api/ram/recommendations', handler: () => net.recommendations() },

    { method: 'GET', path: '/api/ram', handler: () => ({ latest: net.tracker.latest ?? net.sampleRam(), peaks24h: net.tracker.peaks(24 * 60) }) },
    { method: 'GET', path: '/api/ram/history', handler: ({ query }) => net.tracker.history(Math.min(1440, Math.max(1, Number(query.get('minutes') ?? 60))), Math.min(2000, Number(query.get('points') ?? 500))) },
    { method: 'GET', path: '/api/ram/plan', handler: () => net.plan() },
    { method: 'PUT', path: '/api/ram/config', handler: ({ body }) => guarded(() => net.updateRam(body)) },
    { method: 'POST', path: '/api/ram/plan/preview', handler: ({ body }) => guarded(() => net.previewPlan(body)) },
    { method: 'POST', path: '/api/ram/plan/apply', handler: () => guarded(() => net.applyPlan()) },
  ];
}
