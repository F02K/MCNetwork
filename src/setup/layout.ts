import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveServerDir } from '../config';
import type { NetworkConfig, ServerConfig } from '../types';
import { patchProperties, patchYamlBlock } from './textfiles';
import { patchVelocityToml } from './velocity';

/** Backends bind to this address only: players reach them through the proxy, nobody else needs to. */
export const BACKEND_HOST = '127.0.0.1';

export const VELOCITY_TOML = 'velocity.toml';
export const FORWARDING_SECRET = 'forwarding.secret';
export const PAPER_GLOBAL = join('config', 'paper-global.yml');

export const proxyOf = (cfg: NetworkConfig): ServerConfig | undefined => cfg.servers.find((s) => s.role === 'proxy');

/** What the proxy has to know: every backend with a port, and where players land first. */
export function proxyLayout(cfg: NetworkConfig): { servers: Record<string, string>; tryOrder: string[] } {
  const backends = cfg.servers.filter((s) => s.role === 'backend' && s.port !== undefined && !s.standalone);
  const entries = backends.filter((s) => s.entry).map((s) => s.id);
  return {
    servers: Object.fromEntries(backends.map((s) => [s.id, `${BACKEND_HOST}:${s.port}`])),
    tryOrder: entries.length ? entries : backends.slice(0, 1).map((s) => s.id),
  };
}

export interface ProxyOptions {
  bind?: string;
  motd?: string;
  forwardingMode?: 'modern';
}

/**
 * Writes the server list into the proxy's velocity.toml. Returns false when nothing changed (or the
 * file does not exist yet, because the proxy has not been started once).
 */
export function writeProxyConfig(dataDir: string, cfg: NetworkConfig, extra: ProxyOptions = {}): boolean {
  const proxy = proxyOf(cfg);
  if (!proxy) return false;
  const file = join(resolveServerDir(dataDir, proxy), VELOCITY_TOML);
  if (!existsSync(file)) return false;
  const before = readFileSync(file, 'utf8');
  const after = patchVelocityToml(before, { ...proxyLayout(cfg), keepServers: proxy.imported === true, ...extra });
  if (after === before) return false;
  writeFileSync(file, after);
  return true;
}

/** Address a game server listens on, from server.properties ('0.0.0.0' = every address). */
export function backendHost(dir: string): string {
  const file = join(dir, 'server.properties');
  const m = existsSync(file) ? /^server-ip=(.*)$/m.exec(readFileSync(file, 'utf8')) : null;
  return m?.[1].trim() || '0.0.0.0';
}

/** Address and port of the proxy, from `bind` in velocity.toml. */
export function proxyBind(dir: string): { host: string; port: number } | null {
  const file = join(dir, VELOCITY_TOML);
  const m = existsSync(file) ? /^\s*bind\s*=\s*"([^"]*):(\d+)"/m.exec(readFileSync(file, 'utf8')) : null;
  return m ? { host: m[1] || '0.0.0.0', port: Number(m[2]) } : null;
}

/** Moves the proxy to another port: `bind`, and the query port when it was the same. */
export function setProxyPort(text: string, oldPort: number, newPort: number): string {
  let section = '';
  return text
    .split('\n')
    .map((line) => {
      const header = /^\s*\[([^\]]+)\]/.exec(line);
      if (header) section = header[1];
      if (section === '' && /^\s*bind\s*=/.test(line)) return line.replace(/:(\d+)"/, `:${newPort}"`);
      if (section === 'query') {
        const m = /^(\s*port\s*=\s*)(\d+)/.exec(line);
        if (m && Number(m[2]) === oldPort) return `${m[1]}${newPort}`;
      }
      return line;
    })
    .join('\n');
}

export function readForwardingSecret(dataDir: string, proxy: ServerConfig): string | null {
  const file = join(resolveServerDir(dataDir, proxy), FORWARDING_SECRET);
  return existsSync(file) ? readFileSync(file, 'utf8').trim() || null : null;
}

/** Settings a Paper backend needs before its first start (port, local only, proxy handles login). */
export function prepareBackendFiles(dir: string, server: ServerConfig, opts: { keepMotd?: boolean } = {}): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'server.properties');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const values: Record<string, string | number | boolean> = { 'server-port': server.port ?? 25565, 'server-ip': BACKEND_HOST, 'online-mode': false };
  if (!opts.keepMotd) values.motd = server.name; // an imported server keeps its own message
  writeFileSync(file, patchProperties(text, values));
}

/** Tells a Paper backend to trust the proxy's forwarded player data. Needs paper-global.yml from a first start. */
export function writeBackendForwarding(dir: string, secret: string): boolean {
  const file = resolve(dir, PAPER_GLOBAL);
  if (!existsSync(file)) return false;
  writeFileSync(file, patchYamlBlock(readFileSync(file, 'utf8'), ['proxies', 'velocity'], { enabled: true, 'online-mode': true, secret }));
  return true;
}
