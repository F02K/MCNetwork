import { cp, mkdir, readdir, rename, rmdir } from 'node:fs/promises';
import { existsSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { resolveServerDir } from '../config';
import type { Network } from '../network';
import type { MemorySettings, ServerConfig } from '../types';
import { PAPER_GLOBAL, prepareBackendFiles, VELOCITY_TOML } from './layout';
import { allocatePorts, PROXY_PORT } from './ports';

export type ImportMode = 'copy' | 'move' | 'link';

export interface ImportSpec {
  /** Absolute folder of the existing server. */
  path: string;
  /** copy: keep the original and work on a copy; move: take the folder over; link: use it where it is. */
  mode: ImportMode;
  /** Spigot only: replace the jar by Paper of the same Minecraft version (world and plugins stay). */
  convertToPaper?: boolean;
  /** Manage it, but do not put it behind the proxy. Automatic for software that cannot receive forwarded players. */
  standalone?: boolean;
  /** Minecraft version for the conversion when it cannot be read from the folder. */
  version?: string;
}

export const IMPORT_MODES: ImportMode[] = ['copy', 'move', 'link'];

/** Where the files MCNetwork changes in an imported server are saved first. */
export const BACKUP_DIR = '.mcnetwork-backup';

/** Copies the given files (relative to the server folder) into a timestamped backup folder; returns it, or null when none existed. */
export function backupFiles(serverDir: string, files: string[], now = new Date()): string | null {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  let target: string | null = null;
  for (const rel of files) {
    const from = join(serverDir, rel);
    if (!existsSync(from)) continue;
    target ??= join(serverDir, BACKUP_DIR, stamp);
    mkdirSync(dirname(join(target, rel)), { recursive: true });
    copyFileSync(from, join(target, rel));
  }
  return target;
}

/** Port a Velocity proxy listens on, read from `bind` in its velocity.toml (25565 when unknown). */
export function velocityPort(dir: string): number {
  const file = join(dir, VELOCITY_TOML);
  const m = existsSync(file) ? /^\s*bind\s*=\s*"[^"]*?:(\d+)"/m.exec(readFileSync(file, 'utf8')) : null;
  return m ? Number(m[1]) : PROXY_PORT;
}

/** Brings the files to their place in the network folder (copy, move) or leaves them (link). */
export async function placeServer(spec: ImportSpec, dataDir: string, id: string): Promise<{ dir: string; external: boolean }> {
  if (spec.mode === 'link') return { dir: resolve(spec.path), external: true };
  const rel = join('servers', id);
  const dest = resolveServerDir(dataDir, { dir: rel } as ServerConfig);
  if (existsSync(dest) && (await readdir(dest)).length) throw new Error(`The folder ${rel} already has files`);
  await mkdir(dirname(dest), { recursive: true });
  if (spec.mode === 'copy') {
    await cp(spec.path, dest, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  } else {
    if (existsSync(dest)) await rmdir(dest);
    try {
      await rename(spec.path, dest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') throw new Error('The folder is on another disk, so it cannot be moved. Choose "copy" instead.');
      throw err;
    }
  }
  return { dir: rel, external: false };
}

export interface ImportOptions {
  id: string;
  name: string;
  role: 'proxy' | 'backend';
  memory?: MemorySettings;
  /** Players join this one first. */
  entry: boolean;
  acceptEula: boolean;
  isPortFree?: (port: number) => Promise<boolean>;
}

export interface ImportOutcome {
  config: ServerConfig;
  standalone: boolean;
  /** Spigot to Paper: the install step still has to run. */
  convertTo?: { provider: 'paper'; version: string };
  detail: string;
}

const mb = (bytes: number): string => (bytes >= 1 << 30 ? `${(bytes / (1 << 30)).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / (1 << 20)))} MB`);

/**
 * Takes an existing server into the network: checks it, brings the files over, registers it,
 * saves what it is about to change and sets up its ports and EULA. Software and forwarding config
 * that need the server to run follow in the later steps of the setup.
 */
export async function importServer(net: Network, spec: ImportSpec, o: ImportOptions): Promise<ImportOutcome> {
  const report = await net.inspectImport(spec.path);
  if (report.issues.length) throw new Error(report.issues[0]);
  if (o.role === 'proxy' && report.support !== 'proxy') throw new Error('This folder is not a Velocity proxy');
  if (o.role === 'backend' && report.support === 'proxy') throw new Error('This folder is a Velocity proxy, not a game server');

  const needsConversion = report.support === 'convert' && spec.convertToPaper === true;
  const version = report.software?.version ?? spec.version ?? null;
  if (needsConversion && !version) throw new Error('The Minecraft version of this Spigot server is unknown. Enter it to switch to Paper.');
  const standalone = o.role === 'backend' && (spec.standalone === true || report.support === 'standalone' || (report.support === 'convert' && !needsConversion));
  if (o.role === 'backend' && !standalone && !needsConversion && version && /^1\.(\d+)/.exec(version) && Number(/^1\.(\d+)/.exec(version)?.[1]) < 19) {
    throw new Error(`Paper ${version} is too old to receive players from Velocity (1.19 or newer is needed). Import it as a standalone server instead.`);
  }

  const placed = await placeServer(spec, net.dataDir, o.id);
  const dirOf = (c: Pick<ServerConfig, 'dir'>) => resolveServerDir(net.dataDir, c as ServerConfig);

  // ports: a proxy keeps its public port; a networked game server moves to a local one; a standalone one keeps its own if it is free
  const taken = net.config.servers.flatMap((s) => (s.port ? [s.port] : []));
  let port: number;
  let portChanged = false;
  if (o.role === 'proxy') port = velocityPort(dirOf(placed));
  else {
    const own = report.properties?.port ?? 25565;
    if (standalone && !taken.includes(own)) port = own;
    else {
      [port] = await allocatePorts(1, taken, undefined, o.isPortFree);
      portChanged = true;
    }
  }

  const config = await net.addServer({
    id: o.id,
    name: o.name,
    role: o.role,
    dir: placed.dir,
    ...(placed.external ? { external: true } : {}),
    port,
    imported: true,
    ...(standalone ? { standalone: true } : {}),
    ...(o.entry && !standalone ? { entry: true } : {}),
    ...(o.memory ? { memory: o.memory } : {}),
  }).then((v) => v.config);

  const dir = dirOf(config);
  const changes = o.role === 'proxy' ? [VELOCITY_TOML] : standalone ? (portChanged ? ['server.properties'] : []) : ['server.properties', PAPER_GLOBAL];
  const saved = backupFiles(dir, changes);
  if (o.role === 'backend' && !standalone) prepareBackendFiles(dir, config, { keepMotd: true });
  else if (o.role === 'backend' && portChanged) prepareBackendFiles(dir, { ...config, port }, { keepMotd: true }); // standalone with a clash: only the port moves
  if (o.role === 'backend' && report.eula !== 'accepted' && o.acceptEula) await net.instance(o.id).request('acceptEula');

  const how = { copy: 'copied', move: 'moved', link: 'used in place' }[spec.mode];
  const parts = [`${report.software?.type ?? 'server'}${version ? ` ${version}` : ''}`, `${how} (${mb(report.sizeBytes)})`];
  if (standalone) parts.push('managed only, not behind the proxy');
  if (needsConversion) parts.push('will be switched to Paper');
  if (saved) parts.push(`originals of changed files saved in ${BACKUP_DIR}`);
  return { config, standalone, convertTo: needsConversion ? { provider: 'paper', version: version as string } : undefined, detail: parts.join(', ') };
}

export const isAbsolutePath = (p: unknown): p is string => typeof p === 'string' && isAbsolute(p);
