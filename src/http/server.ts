import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Network } from '../network';
import type { HttpConfig } from '../types';
import { buildRoutes } from './routes';
import { compile, HttpError, match, readBody, type Context } from './router';

const sha = (s: string): Buffer => createHash('sha256').update(s).digest();

function authorized(token: string, req: IncomingMessage, query: URLSearchParams): boolean {
  if (!token) return true;
  const header = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
  const given = header ?? query.get('token') ?? ''; // EventSource cannot send headers
  return timingSafeEqual(sha(given), sha(token));
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

/** Server-sent events: every server event, status update and RAM frame, as they happen. */
function stream(net: Network, req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const write = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const handlers: [string, (arg?: unknown) => void][] = [
    ['server-event', (e: unknown) => write('server', e)],
    ['status', (e: unknown) => write('status', e)],
    ['ram', (f: unknown) => write('ram', f)],
    ['pressure', (p: unknown) => write('pressure', { level: p })],
    ['servers', () => write('servers', net.views().map((v) => v.config))],
    ['setup', (s: unknown) => write('setup', s)],
  ];
  for (const [name, fn] of handlers) net.on(name, fn);
  write('hello', { servers: net.views().length });
  const beat = setInterval(() => res.write(': keep-alive\n\n'), 20_000);
  req.on('close', () => {
    clearInterval(beat);
    for (const [name, fn] of handlers) net.off(name, fn);
  });
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

/** Serves a file of the dashboard; "/" is index.html. Never leaves the web folder. */
function serveStatic(webDir: string, pathname: string, res: ServerResponse): boolean {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, '') || 'index.html';
  const file = join(webDir, rel);
  if (!file.startsWith(webDir + sep) || !existsSync(file) || !statSync(file).isFile()) return false;
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  res.end(readFileSync(file));
  return true;
}

export interface HttpHandle {
  server: Server;
  listen(): Promise<number>;
  close(): Promise<void>;
}

export function createHttpServer(net: Network, cfg: HttpConfig, webDir?: string): HttpHandle {
  const table = compile(buildRoutes(net));
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      try {
        if (webDir && req.method === 'GET' && !url.pathname.startsWith('/api/') && serveStatic(webDir, url.pathname, res)) return;
        if (!authorized(cfg.token, req, url.searchParams)) throw new HttpError(401, 'Missing or wrong token');
        if (req.method === 'GET' && url.pathname === '/api/events') return stream(net, req, res);
        const found = match(table, req.method ?? 'GET', url.pathname);
        if (found === null) throw new HttpError(404, 'Not found');
        if (found === 'method') throw new HttpError(405, 'Method not allowed');
        const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : {};
        const ctx: Context = { params: found.params, query: url.searchParams, body, req, res };
        const result = await found.route.handler(ctx);
        send(res, result === undefined ? 204 : 200, result);
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        send(res, status, { error: status === 500 ? 'Internal error' : (err as Error).message });
      }
    })();
  });
  return {
    server,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(cfg.port, cfg.host, () => resolve((server.address() as AddressInfo).port));
      }),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
