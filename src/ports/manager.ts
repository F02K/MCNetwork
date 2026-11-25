import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveServerDir } from '../config';
import type { Network, ServerView } from '../network';
import { backupFiles } from '../setup/importer';
import { BACKEND_HOST, backendHost, proxyBind, VELOCITY_TOML } from '../setup/layout';
import { isListening } from '../setup/probe';
import { patchProperties } from '../setup/textfiles';
import { setProxyPort } from '../setup/layout';

export interface PortRow {
  id: string;
  name: string;
  role: 'proxy' | 'backend';
  port: number | null;
  /** Address it listens on; 0.0.0.0 means every address. */
  host: string;
  exposure: 'local' | 'public';
  /** Something accepts connections on the port right now. */
  listening: boolean;
  state: string;
  standalone: boolean;
  /** Things to fix, in plain words. */
  issues: string[];
  /** The exposure problem can be fixed with one click. */
  canMakeLocal: boolean;
}

const isLocalHost = (h: string): boolean => h.startsWith('127.') || h === 'localhost' || h === '::1';

/** The port players connect to: the proxy's. */
export function proxyPort(net: Network): number | null {
  const proxy = net.config.servers.find((s) => s.role === 'proxy');
  if (!proxy) return null;
  return proxyBind(resolveServerDir(net.dataDir, proxy))?.port ?? proxy.port ?? null;
}

/** Every server's port, where it listens, whether it is up, and what is wrong with it. */
export async function portOverview(net: Network): Promise<{ rows: PortRow[]; publicPort: number | null }> {
  const counts = new Map<number, number>();
  for (const s of net.config.servers) if (s.port) counts.set(s.port, (counts.get(s.port) ?? 0) + 1);
  const rows = await Promise.all(
    net.config.servers.map(async (s): Promise<PortRow> => {
      const dir = resolveServerDir(net.dataDir, s);
      const view = net.view(s.id);
      const state = view.status?.state ?? 'stopped';
      const bind = s.role === 'proxy' ? proxyBind(dir) : null;
      const port = bind?.port ?? s.port ?? null;
      const host = s.role === 'proxy' ? (bind?.host ?? '0.0.0.0') : backendHost(dir);
      const exposure = isLocalHost(host) ? 'local' : 'public';
      const listening = port !== null && (await isListening(port, host === '0.0.0.0' ? '127.0.0.1' : host));
      const issues: string[] = [];
      if (port !== null && (counts.get(port) ?? 0) > 1) issues.push(`Port ${port} is used by more than one server of this network.`);
      if (listening && state === 'stopped') issues.push(`Another program is using port ${port}.`);
      if (s.role === 'backend' && !s.standalone && exposure === 'public') issues.push('Players could connect to this game server directly and skip the proxy (and its login check). It should listen on 127.0.0.1 only.');
      if (s.role === 'proxy' && exposure === 'local') issues.push('The proxy only listens on this machine, so nobody else can join.');
      if (port !== null && port < 1024 && process.platform !== 'win32') issues.push('Ports below 1024 need administrator rights on Linux and macOS.');
      return { id: s.id, name: s.name, role: s.role, port, host, exposure, listening, state, standalone: s.standalone === true, issues, canMakeLocal: s.role === 'backend' && !s.standalone && exposure === 'public' };
    }),
  );
  return { rows, publicPort: rows.find((r) => r.role === 'proxy')?.port ?? null };
}

/**
 * Moves a stopped server to another port (and/or makes a game server listen on this machine only),
 * writes the change into its own files, and tells the proxy. The server picks it up at its next start.
 */
export async function changePort(net: Network, id: string, patch: { port?: number; localOnly?: boolean }): Promise<ServerView> {
  const inst = net.instance(id);
  const cfg = net.config.servers.find((s) => s.id === id);
  if (!cfg) throw new Error(`Unknown server "${id}"`);
  if (inst.status && inst.status.state !== 'stopped') throw new Error('Stop the server first: it only reads its port when it starts');
  if (patch.port === undefined && !patch.localOnly) throw new Error('Nothing to change: give a "port" or "localOnly"');
  if (patch.localOnly && cfg.role !== 'backend') throw new Error('Only game servers can be limited to this machine; the proxy has to be reachable');

  const dir = resolveServerDir(net.dataDir, cfg);
  const oldPort = cfg.port ?? 0;
  const newPort = patch.port ?? oldPort;
  if (patch.port !== undefined) {
    if (!Number.isInteger(patch.port) || patch.port < 1 || patch.port > 65535) throw new Error('The port must be a whole number from 1 to 65535');
    const clash = net.config.servers.find((s) => s.id !== id && s.port === patch.port);
    if (clash) throw new Error(`Port ${patch.port} belongs to "${clash.id}"`);
    if (patch.port !== oldPort && (await isListening(patch.port))) throw new Error(`Another program is already using port ${patch.port}`);
  }

  if (cfg.imported) backupFiles(dir, cfg.role === 'proxy' ? [VELOCITY_TOML] : ['server.properties']);
  if (cfg.role === 'proxy') {
    const file = join(dir, VELOCITY_TOML);
    if (existsSync(file)) writeFileSync(file, setProxyPort(readFileSync(file, 'utf8'), oldPort, newPort));
  } else {
    const file = join(dir, 'server.properties');
    const values: Record<string, string | number> = { 'server-port': newPort };
    if (patch.localOnly) values['server-ip'] = BACKEND_HOST;
    writeFileSync(file, patchProperties(existsSync(file) ? readFileSync(file, 'utf8') : '', values));
  }
  return net.setPort(id, newPort);
}
