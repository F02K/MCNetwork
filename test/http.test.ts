import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHttpServer } from '../src/http/server';
import { AGENT_TOKEN, makeNetwork, server, tmp, waitFor } from './helpers';

let base = '';
// created at file level so that its cleanup hooks belong to the whole file, not to the before() hook
const { net } = makeNetwork([server('proxy', { role: 'proxy' }), server('lobby')]);
let closeHttp: () => Promise<void> = () => Promise.resolve();
after(() => closeHttp());

const TOKEN = 's3cret';
const headers = { authorization: `Bearer ${TOKEN}` };

async function call(method: string, path: string, body?: unknown, h: Record<string, string> = headers): Promise<{ status: number; json: unknown }> {
  const res = await fetch(base + path, { method, headers: { ...h, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as unknown) : undefined };
}

before(async () => {
  const web = tmp('web');
  mkdirSync(join(web, 'js'));
  writeFileSync(join(web, 'index.html'), '<h1>dash</h1>');
  writeFileSync(join(web, 'js', 'app.js'), 'export {}');
  writeFileSync(join(tmp('outside'), 'secret.txt'), 'x');
  const http = createHttpServer(net, { host: '127.0.0.1', port: 0, token: TOKEN }, web);
  const port = await http.listen();
  base = `http://127.0.0.1:${port}`;
  closeHttp = () => http.close();
  await net.start();
  await waitFor(() => net.view('lobby').status?.state === 'running', 5000, 'lobby running');
});

describe('HTTP API', () => {
  it('rejects requests without or with a wrong token', async () => {
    assert.equal((await call('GET', '/api/servers', undefined, {})).status, 401);
    assert.equal((await call('GET', '/api/servers', undefined, { authorization: 'Bearer nope' })).status, 401);
    assert.equal((await fetch(`${base}/api/servers?token=${TOKEN}`)).status, 200);
  });

  it('answers 404 / 405 / 400 / 413 for bad requests', async () => {
    assert.equal((await call('GET', '/api/nothing')).status, 404);
    assert.equal((await call('PUT', '/api/servers')).status, 405);
    const raw = await fetch(`${base}/api/servers`, { method: 'POST', headers, body: '[1,2]' });
    assert.equal(raw.status, 400);
    const broken = await fetch(`${base}/api/servers`, { method: 'POST', headers, body: '{ nope' });
    assert.equal(broken.status, 400);
    const huge = await fetch(`${base}/api/servers/lobby/command`, { method: 'POST', headers, body: JSON.stringify({ text: 'x'.repeat(100_000) }) }).catch(() => null);
    assert.ok(huge === null || huge.status === 413);
    assert.equal((await call('GET', '/api/servers/ghost')).status, 404);
    assert.equal((await call('POST', '/api/servers/lobby/command', {})).status, 400);
  });

  it('lists servers and returns one with its live status', async () => {
    const list = (await call('GET', '/api/servers')).json as { config: { id: string }; status: { state: string } | null }[];
    assert.deepEqual(list.map((s) => s.config.id), ['proxy', 'lobby']);
    const one = (await call('GET', '/api/servers/lobby')).json as { status: { state: string; software: { type: string } } };
    assert.equal(one.status.state, 'running');
    assert.equal(one.status.software.type, 'paper');
    const overview = (await call('GET', '/api/network')).json as { servers: unknown[]; plan: { allocations: unknown[] } };
    assert.equal(overview.servers.length, 2);
    assert.equal(overview.plan.allocations.length, 2);
  });

  it('controls a server through MCLI', async () => {
    assert.equal((await call('POST', '/api/servers/lobby/stop')).status, 200);
    assert.equal((await call('POST', '/api/servers/lobby/command', { text: 'list' })).json, false);
    assert.equal((await call('POST', '/api/servers/lobby/start')).status, 200);
    await waitFor(() => net.view('lobby').status?.state === 'running', 3000, 'running again');
    assert.equal((await call('POST', '/api/servers/lobby/command', { text: 'join Steve' })).json, true);
    assert.deepEqual((await call('GET', '/api/servers/lobby/versions?provider=paper')).json, ['1.21.8', '1.21.7']);
    assert.equal(((await call('GET', '/api/servers/lobby/logs?limit=5')).json as unknown[]).length, 1);
    const bad = await call('POST', '/api/servers/lobby/install', { provider: 'paper' });
    assert.equal(bad.status, 400);
  });

  it('creates and removes servers', async () => {
    const created = await call('POST', '/api/servers', { id: 'creative', memory: { weight: 2 } });
    assert.equal(created.status, 200);
    assert.equal((await call('POST', '/api/servers', { id: 'creative' })).status, 400);
    const removed = await call('DELETE', '/api/servers/creative');
    assert.deepEqual(removed.json, { removed: 'creative' });
    assert.equal((await call('GET', '/api/servers/creative')).status, 404);
  });

  it('serves RAM data: latest, history, plan and apply', async () => {
    net.sampleRam();
    const ram = (await call('GET', '/api/ram')).json as { latest: { servers: Record<string, { rssMb: number }> }; peaks24h: Record<string, number> };
    assert.equal(ram.latest.servers.lobby.rssMb, 600);
    assert.equal(ram.peaks24h.lobby, 600);
    const history = (await call('GET', '/api/ram/history?minutes=10&points=5')).json as unknown[];
    assert.ok(history.length >= 1 && history.length <= 5);
    const plan = (await call('GET', '/api/ram/plan')).json as { allocations: { id: string }[]; budgetMb: number };
    assert.deepEqual(plan.allocations.map((a) => a.id), ['proxy', 'lobby']);
    const applied = (await call('POST', '/api/ram/plan/apply')).json as { applied: { id: string }[]; failed: unknown[] };
    assert.equal(applied.applied.length, 2);
    assert.deepEqual(applied.failed, []);
  });

  it('streams events over SSE', async () => {
    const res = await fetch(`${base}/api/events?token=${TOKEN}`);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let text = '';
    const read = async (until: RegExp) => {
      while (!until.test(text)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
    };
    await read(/event: hello/);
    net.sampleRam();
    await read(/event: ram/);
    await net.instance('lobby').refresh();
    await read(/event: status/);
    assert.match(text, /event: hello\ndata: \{"servers":2\}/);
    await reader.cancel();
  });

  it('serves the dashboard without a token, but never files outside its folder', async () => {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(await index.text(), '<h1>dash</h1>');
    const js = await fetch(`${base}/js/app.js`);
    assert.match(js.headers.get('content-type') ?? '', /javascript/);
    assert.equal((await fetch(`${base}/nope.css`)).status, 401, 'unknown paths fall through to the (protected) API');
    assert.equal((await fetch(`${base}/..%2F..%2Fetc%2Fpasswd`)).status, 401);
    assert.equal((await fetch(`${base}/%2e%2e/%2e%2e/etc/passwd`)).status, 401);
  });

  it('exposes setup defaults and validates a setup request', async () => {
    const defaults = (await call('GET', '/api/setup/defaults')).json as { paper: { default: string; versions: string[] }; velocity: { default: string }; ram: { totalMb: number }; configured: boolean };
    assert.equal(defaults.paper.default, '1.21.8');
    assert.equal(defaults.velocity.default, '3.5.1');
    assert.ok(defaults.ram.totalMb > 0);
    assert.equal(defaults.configured, true);
    assert.equal((await call('GET', '/api/setup')).json, null);
    const bad = await call('POST', '/api/setup', { backends: [{ id: 'x' }], acceptEula: false });
    assert.equal(bad.status, 400);
    assert.match((bad.json as { error: string }).error, /EULA/);
  });

  it('updates a server and previews a RAM plan', async () => {
    const put = await call('PUT', '/api/servers/lobby', { name: 'Hub', memory: { weight: 3 } });
    assert.equal(put.status, 200);
    assert.equal((put.json as { config: { name: string } }).config.name, 'Hub');
    assert.equal((await call('PUT', '/api/servers/lobby', { id: 'x' })).status, 400);
    const preview = (await call('POST', '/api/ram/plan/preview', { servers: [{ id: 'a' }, { id: 'b', memory: { weight: 8 } }] })).json as { allocations: { id: string }[] };
    assert.deepEqual(preview.allocations.map((a) => a.id), ['a', 'b']);
    assert.equal((await call('POST', '/api/ram/plan/preview', { servers: 5 })).status, 400);
  });

  it('changes the RAM reserve', async () => {
    const ok = await call('PUT', '/api/ram/config', { reserveMb: 3000 });
    assert.deepEqual(ok.json, { totalMb: 0, reserveMb: 3000 });
    assert.equal((await call('PUT', '/api/ram/config', { reserveMb: 'lots' })).status, 400);
    await call('PUT', '/api/ram/config', { reserveMb: 0 });
  });

  it('accepts reports from agents with the agent token only, and answers with their orders', async () => {
    const report = { serverId: 'lobby', kind: 'paper', agentVersion: '0.1.0', time: 1, jvm: { heapUsedMb: 1, heapCommittedMb: 2, heapMaxMb: 3, nonHeapUsedMb: 1, liveSetMb: 1, gcCount: 0, gcTimeMs: 0, threads: 1, uptimeMs: 1, processors: 1, processCpu: null }, game: { tps: [20, 20, 20], mspt: 1, players: 0, maxPlayers: 20, version: '1.21.8', worlds: [] }, results: [] };
    const send = (token: string | null, body: unknown) => fetch(`${base}/api/agent/report`, { method: 'POST', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await send(null, report)).status, 401);
    assert.equal((await send(TOKEN, report)).status, 401, 'the dashboard token is not the agent token');
    assert.equal((await send(AGENT_TOKEN, { ...report, serverId: 'ghost' })).status, 404);
    const bad = await send(AGENT_TOKEN, { ...report, jvm: 5 });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /jvm/);

    const first = await send(AGENT_TOKEN, report);
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { ok: true, commands: [] });

    // the dashboard asks for a gc; the agent gets it with its next report and reports the outcome after that
    const order = (await call('POST', '/api/servers/lobby/gc')).json as { id: string };
    const second = (await (await send(AGENT_TOKEN, report)).json()) as { commands: { id: string; type: string }[] };
    assert.deepEqual(second.commands, [{ id: order.id, type: 'gc' }]);
    await send(AGENT_TOKEN, { ...report, results: [{ id: order.id, ok: true, message: 'heap in use 400 MB -> 200 MB' }] });
    const view = (await call('GET', '/api/servers/lobby')).json as { agent: { connected: boolean; commands: { id: string; done: boolean; message: string }[]; game: { tps: number[] } } };
    assert.equal(view.agent.connected, true);
    assert.equal(view.agent.game.tps[0], 20);
    assert.equal(view.agent.commands[0].done, true);
    assert.match(view.agent.commands[0].message, /200 MB/);
  });

  it('offers the agent routes: status, reinstall, orders and recommendations', async () => {
    const info = (await call('GET', '/api/agent')).json as { enabled: boolean; bundledVersion: string };
    assert.deepEqual(info, { enabled: true, bundledVersion: '0.1.0' });
    const installed = (await call('POST', '/api/servers/lobby/agent/install')).json as { kind: string };
    assert.equal(installed.kind, 'paper');
    assert.equal((await call('POST', '/api/servers/lobby/agent/command', { type: 'gc' })).status, 200);
    assert.equal((await call('POST', '/api/servers/lobby/agent/command', {})).status, 400);
    assert.equal((await call('POST', '/api/servers/lobby/agent/command', { type: 'nope' })).status, 400);
    assert.equal((await call('POST', '/api/servers/lobby/evacuate', { to: 'lobby' })).status, 400);
    const recs = (await call('GET', '/api/ram/recommendations')).json as { id: string; state: string }[];
    assert.deepEqual(recs.map((r) => r.id), ['proxy', 'lobby']);
  });
});
