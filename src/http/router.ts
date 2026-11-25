import type { IncomingMessage, ServerResponse } from 'node:http';

export interface Context {
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
  req: IncomingMessage;
  res: ServerResponse;
}

/** A handler returns the JSON reply (or undefined for "no content" / when it wrote the response itself). */
export type Handler = (ctx: Context) => unknown;

export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path with ":name" segments, e.g. /api/servers/:id/start */
  path: string;
  handler: Handler;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Compiled {
  route: Route;
  re: RegExp;
  names: string[];
}

export function compile(routes: Route[]): Compiled[] {
  return routes.map((route) => {
    const names: string[] = [];
    const re = new RegExp('^' + route.path.replace(/:(\w+)/g, (_m, n: string) => (names.push(n), '([^/]+)')) + '/?$');
    return { route, re, names };
  });
}

/** Finds the route for a request; reports "wrong method" separately from "unknown path". */
export function match(table: Compiled[], method: string, path: string): { route: Route; params: Record<string, string> } | 'method' | null {
  let pathMatched = false;
  for (const c of table) {
    const m = c.re.exec(path);
    if (!m) continue;
    pathMatched = true;
    if (c.route.method !== method) continue;
    const params: Record<string, string> = {};
    c.names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1])));
    return { route: c.route, params };
  }
  return pathMatched ? 'method' : null;
}

const MAX_BODY = 64 * 1024;

export function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (!size) return resolve({});
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new HttpError(400, 'Body must be a JSON object'));
      }
    });
  });
}
