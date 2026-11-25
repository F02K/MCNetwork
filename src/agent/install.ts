import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync as writeFile } from 'node:fs';
import { join } from 'node:path';
import type { Role } from '../types';

export interface JarInfo {
  file: string;
  size: number;
  sha256: string;
}

export interface AgentManifest {
  version: string;
  jars: { paper: JarInfo; velocity: JarInfo };
}

export type AgentKind = 'paper' | 'velocity';
export const agentKind = (role: Role): AgentKind => (role === 'proxy' ? 'velocity' : 'paper');

export const AGENT_JAR = 'MCNetworkAgent.jar';
/** Folder in which each plugin looks for config.properties: Paper uses the plugin name, Velocity the plugin id. */
const CONFIG_DIR: Record<AgentKind, string> = { paper: 'MCNetworkAgent', velocity: 'mcnetwork-agent' };

/** Reads agent/jars/manifest.json; null when the plugins were not built (the network then runs without them). */
export function loadManifest(jarsDir: string): AgentManifest | null {
  try {
    const m = JSON.parse(readFileSync(join(jarsDir, 'manifest.json'), 'utf8')) as AgentManifest;
    return m?.jars?.paper && m.jars.velocity && typeof m.version === 'string' ? m : null;
  } catch {
    return null;
  }
}

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

export interface InstallSettings {
  /** Where the plugins reach the daemon, e.g. http://127.0.0.1:8080 */
  url: string;
  token: string;
  serverId: string;
  intervalSeconds?: number;
}

export interface InstallResult {
  kind: AgentKind;
  version: string;
  jar: 'installed' | 'updated' | 'current';
  config: 'written' | 'current';
}

/** The text of config.properties for one server. */
export function agentConfigText(s: InstallSettings): string {
  return ['# Written by MCNetwork. Changes are overwritten.', `url=${s.url}`, `token=${s.token}`, `server-id=${s.serverId}`, `interval-seconds=${s.intervalSeconds ?? 10}`, ''].join('\n');
}

/**
 * Puts the agent plugin and its configuration into a server folder. The bundled jar is verified
 * against the manifest first; an older or modified jar is replaced, the configuration is rewritten
 * when URL, token or server id changed.
 */
export function installAgent(serverDir: string, role: Role, jarsDir: string, settings: InstallSettings, write: typeof writeFile = writeFile): InstallResult {
  const manifest = loadManifest(jarsDir);
  if (!manifest) throw new Error(`The agent plugins are missing (${join(jarsDir, 'manifest.json')}). Build them with "npm run build:agent".`);
  const kind = agentKind(role);
  const info = manifest.jars[kind];
  const bundled = readFileSync(join(jarsDir, info.file));
  if (sha256(bundled) !== info.sha256) throw new Error(`${info.file} does not match the manifest. Rebuild with "npm run build:agent".`);

  const plugins = join(serverDir, 'plugins');
  mkdirSync(join(plugins, CONFIG_DIR[kind]), { recursive: true });
  const target = join(plugins, AGENT_JAR);
  let jar: InstallResult['jar'] = 'installed';
  if (existsSync(target)) jar = sha256(readFileSync(target)) === info.sha256 ? 'current' : 'updated';
  if (jar !== 'current') {
    try {
      write(target, bundled);
    } catch (err) {
      // Windows locks a jar that a running server has loaded
      if (['EBUSY', 'EPERM', 'EACCES'].includes((err as NodeJS.ErrnoException).code ?? '')) throw new Error(`Cannot replace ${AGENT_JAR}: the server is running and holds the file. Stop the server, then try again.`);
      throw err;
    }
  }

  const configFile = join(plugins, CONFIG_DIR[kind], 'config.properties');
  const text = agentConfigText(settings);
  let config: InstallResult['config'] = 'written';
  if (existsSync(configFile) && readFileSync(configFile, 'utf8') === text) config = 'current';
  else write(configFile, text);
  return { kind, version: manifest.version, jar, config };
}
