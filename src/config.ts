import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { MemorySettings, NetworkConfig, ServerConfig } from './types';

export const CONFIG_FILE = 'mcnetwork.json';
export const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function defaultConfig(): NetworkConfig {
  return {
    mcliPath: process.env.MCLI_PATH ?? 'mcli.js',
    http: { host: '127.0.0.1', port: 8080, token: '' },
    ram: { totalMb: 0, reserveMb: 0, sampleSeconds: 10 },
    agent: { enabled: true, token: randomBytes(24).toString('hex') },
    ports: { upnp: false },
    servers: [],
  };
}

function num(v: unknown, what: string, min = 0): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min) throw new Error(`${what} must be a number >= ${min}`);
  return v;
}

function validateMemory(m: unknown): MemorySettings {
  if (m === undefined) return {};
  if (typeof m !== 'object' || m === null) throw new Error('"memory" must be an object');
  const raw = m as Record<string, unknown>;
  const out: MemorySettings = {};
  for (const key of ['weight', 'minMb', 'maxMb', 'pinnedMb'] as const) {
    if (raw[key] !== undefined) out[key] = num(raw[key], `memory.${key}`, key === 'weight' ? 0.01 : 64);
  }
  if (out.minMb !== undefined && out.maxMb !== undefined && out.minMb > out.maxMb) throw new Error('memory.minMb cannot be larger than memory.maxMb');
  return out;
}

/** True when `dir` (relative to the data folder) stays inside it. */
export function insideDataDir(dataDir: string, dir: string): boolean {
  if (isAbsolute(dir)) return false;
  const rel = relative(resolve(dataDir), resolve(dataDir, dir));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Checks one server entry and fills in defaults; throws an Error that names the problem. */
export function validateServer(input: unknown, dataDir: string): ServerConfig {
  if (typeof input !== 'object' || input === null) throw new Error('Server must be an object');
  const s = input as Record<string, unknown>;
  if (typeof s.id !== 'string' || !ID_RE.test(s.id)) throw new Error('"id" must be 1-32 characters: lowercase letters, digits, "-" or "_"');
  const role = s.role === undefined ? 'backend' : s.role;
  if (role !== 'proxy' && role !== 'backend') throw new Error('"role" must be "proxy" or "backend"');
  const dir = s.dir === undefined ? join('servers', s.id) : s.dir;
  if (s.external !== undefined && typeof s.external !== 'boolean') throw new Error('"external" must be true or false');
  if (s.standalone !== undefined && typeof s.standalone !== 'boolean') throw new Error('"standalone" must be true or false');
  if (typeof dir !== 'string') throw new Error('"dir" must be a folder');
  if (s.external === true) {
    if (!isAbsolute(dir) || dir.split(/[\\/]/).includes('..')) throw new Error('"dir" of an imported server must be an absolute folder without ".."');
  } else if (!insideDataDir(dataDir, dir)) throw new Error('"dir" must be a relative folder inside the data directory');
  if (s.name !== undefined && typeof s.name !== 'string') throw new Error('"name" must be a string');
  if (s.autoStart !== undefined && typeof s.autoStart !== 'boolean') throw new Error('"autoStart" must be true or false');
  const out: ServerConfig = { id: s.id, name: typeof s.name === 'string' && s.name ? s.name : s.id, role, dir, autoStart: s.autoStart !== false, memory: validateMemory(s.memory) };
  if (s.port !== undefined) {
    if (typeof s.port !== 'number' || !Number.isInteger(s.port) || s.port < 1 || s.port > 65535) throw new Error('"port" must be a whole number from 1 to 65535');
    out.port = s.port;
  }
  if (s.imported === true) out.imported = true;
  if (s.external === true) out.external = true;
  if (s.standalone === true) out.standalone = true;
  if (s.entry !== undefined) {
    if (typeof s.entry !== 'boolean') throw new Error('"entry" must be true or false');
    if (s.entry) out.entry = true;
  }
  return out;
}

/** Reads and validates the configuration; a missing file gives the defaults. */
export function loadConfig(dataDir: string): NetworkConfig {
  const file = join(dataDir, CONFIG_FILE);
  const base = defaultConfig();
  if (!existsSync(file)) return base;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Cannot parse ${file}: ${(err as Error).message}`);
  }
  const http = { ...base.http, ...(raw.http as object | undefined) };
  const ram = { ...base.ram, ...(raw.ram as object | undefined) };
  const agent = { ...base.agent, ...(raw.agent as object | undefined) };
  if (typeof agent.enabled !== 'boolean') throw new Error('agent.enabled must be true or false');
  if (typeof agent.token !== 'string' || !agent.token) agent.token = base.agent.token; // a missing token is generated (and saved on start)
  const ports = { ...base.ports, ...(raw.ports as object | undefined) };
  if (typeof ports.upnp !== 'boolean') throw new Error('ports.upnp must be true or false');
  num(http.port, 'http.port', 0);
  num(ram.totalMb, 'ram.totalMb');
  num(ram.reserveMb, 'ram.reserveMb');
  num(ram.sampleSeconds, 'ram.sampleSeconds', 1);
  const rawServers = Array.isArray(raw.servers) ? (raw.servers as unknown[]) : [];
  const servers = rawServers.map((s) => validateServer(s, dataDir));
  const ids = new Set<string>();
  for (const s of servers) {
    if (ids.has(s.id)) throw new Error(`Duplicate server id "${s.id}"`);
    ids.add(s.id);
  }
  const cfg: NetworkConfig = { mcliPath: typeof raw.mcliPath === 'string' && raw.mcliPath ? raw.mcliPath : base.mcliPath, http, ram, agent, ports, servers };
  if (!isLoopback(cfg.http.host) && !cfg.http.token) throw new Error('http.token is required when http.host is not a loopback address');
  return cfg;
}

export const isLoopback = (host: string): boolean => host === 'localhost' || host === '::1' || host.startsWith('127.');

/** Writes the configuration atomically (temp file, then rename). */
export function saveConfig(dataDir: string, cfg: NetworkConfig): void {
  const file = join(dataDir, CONFIG_FILE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(cfg, null, 2) + '\n');
  renameSync(`${file}.tmp`, file);
}

export const resolveServerDir = (dataDir: string, s: ServerConfig): string => resolve(dataDir, s.dir);
export const resolveMcliPath = (dataDir: string, cfg: NetworkConfig): string => resolve(dataDir, cfg.mcliPath);
