import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { defaultConfig } from '../src/config';
import { Network, type NetworkOptions } from '../src/network';
import type { SystemMemory } from '../src/ram/system';
import type { NetworkConfig, ServerConfig } from '../src/types';

const created: string[] = [];

/** A fresh temp folder that is deleted when the test file finishes. */
export function tmp(name = 'mcnetwork'): string {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  created.push(dir);
  return dir;
}

after(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
});

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function waitFor(cond: () => unknown, ms = 5000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(15);
  }
}

/** The stand-in for mcli.js (compiled next to the tests). */
export const FAKE_MCLI = join(__dirname, 'fake-mcli.js');

export const server = (id: string, extra: Partial<ServerConfig> = {}): ServerConfig => ({ id, name: id, role: 'backend', dir: `servers/${id}`, autoStart: true, memory: {}, ...extra });

export const SYSTEM_8G: SystemMemory = { totalMb: 8192, availableMb: 6000, usedMb: 2192 };

/** A network with the fake MCLI; the machine has 8 GB unless told otherwise. */
export function makeNetwork(servers: ServerConfig[], cfg: Partial<NetworkConfig> = {}, opts: NetworkOptions = {}): { net: Network; dir: string; config: NetworkConfig } {
  const dir = tmp();
  const config: NetworkConfig = { ...defaultConfig(), mcliPath: FAKE_MCLI, http: { host: '127.0.0.1', port: 0, token: '' }, servers, ...cfg };
  const net = new Network(dir, config, { systemMemory: () => SYSTEM_8G, instance: { respawnMs: 30, stopTimeoutMs: 3000 }, ...opts });
  after(() => net.stop().then(() => undefined));
  return { net, dir, config };
}
