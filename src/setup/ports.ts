import { createServer } from 'node:net';

/** True when nothing listens on `port` (checked by binding it briefly). */
export function portFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

export const PROXY_PORT = 25565;
export const BACKEND_PORT_START = 30066;

/** The next `count` ports from `start` that are neither taken by the network nor used by another program. */
export async function allocatePorts(count: number, taken: Iterable<number>, start = BACKEND_PORT_START, isFree = portFree): Promise<number[]> {
  const used = new Set(taken);
  const out: number[] = [];
  for (let port = start; out.length < count; port++) {
    if (port > 65535) throw new Error('No free port left');
    if (!used.has(port) && (await isFree(port))) out.push(port);
  }
  return out;
}
