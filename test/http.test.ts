import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createHttpServer } from '../src/http/server';
import { makeNetwork, server, waitFor } from './helpers';

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
  const http = createHttpServer(net, { host: '127.0.0.1', port: 0, token: TOKEN });
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
});
