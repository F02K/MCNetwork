import { saveConfig } from '../config';
import type { Network } from '../network';
import { proxyOf } from '../setup/layout';
import { detectFirewall, lanAddresses, runProgram, type FirewallInfo, type LanAddress, type Run } from './firewall';
import { checkFromInternet, publicIp, type Fetch, type ReachResult } from './reach';
import { Upnp, isPrivateAddress, localAddressFor, type Gateway } from './upnp';
import { proxyPort } from './manager';

export interface Mapping {
  port: number;
  /** Name of the router that holds the mapping. */
  router: string;
  externalIp: string | null;
  /** The machine the router forwards to. */
  internalClient: string;
  openedAt: number;
  renewedAt: number;
}

export interface AccessInfo {
  proxyPort: number | null;
  proxyRunning: boolean;
  lan: LanAddress[];
  firewall: FirewallInfo | null;
  upnp: { enabled: boolean; mapping: Mapping | null; error: string | null };
  /** What players type: the public address and port, when known. */
  address: string | null;
  /** The address the router reports is a private one: port forwarding cannot work. */
  carrierNat: boolean;
}

/** Test hooks; everything defaults to the real thing. */
export interface PortTools {
  upnp?: Upnp;
  run?: Run;
  fetch?: Fetch;
  lan?: () => LanAddress[];
  localAddress?: (host: string) => Promise<string | null>;
  platform?: string;
  inContainer?: boolean;
  renewMs?: number;
}

const realFetch: Fetch = (url, init) => fetch(url, init);

/**
 * Makes the proxy reachable from the internet: tells which firewall command to run, asks the router
 * to forward the port (UPnP) and renews that while the daemon runs, and checks from outside.
 */
export class PortAccess {
  mapping: Mapping | null = null;
  lastError: string | null = null;
  private gateway: Gateway | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly upnp: Upnp;

  constructor(
    private net: Network,
    private tools: PortTools = {},
  ) {
    this.upnp = tools.upnp ?? new Upnp();
  }

  private get port(): number | null {
    return proxyPort(this.net);
  }

  async info(): Promise<AccessInfo> {
    const port = this.port;
    const proxy = proxyOf(this.net.config);
    const externalIp = this.mapping?.externalIp ?? null;
    return {
      proxyPort: port,
      proxyRunning: proxy ? this.net.view(proxy.id).status?.state === 'running' : false,
      lan: (this.tools.lan ?? lanAddresses)(),
      firewall: port === null ? null : await detectFirewall(port, this.tools.run ?? runProgram, this.tools.platform, this.tools.inContainer),
      upnp: { enabled: this.net.config.ports.upnp, mapping: this.mapping, error: this.lastError },
      address: externalIp && port !== null && !isPrivateAddress(externalIp) ? `${externalIp}:${port}` : null,
      carrierNat: externalIp !== null && isPrivateAddress(externalIp),
    };
  }

  /** Looks for a router that can forward ports. */
  async discover(): Promise<{ found: boolean; router?: string; host?: string; externalIp?: string | null; carrierNat?: boolean }> {
    const gw = await this.upnp.discover();
    this.gateway = gw;
    if (!gw) return { found: false };
    const externalIp = await this.upnp.externalIp(gw).catch(() => null);
    return { found: true, router: gw.name, host: gw.host, externalIp, carrierNat: externalIp ? isPrivateAddress(externalIp) : false };
  }

  /** Forwards the proxy's port on the router and keeps it forwarded while the daemon runs. */
  async open(): Promise<Mapping> {
    const port = this.port;
    if (port === null) throw new Error('There is no proxy yet, so there is no port to open');
    const gw = this.gateway ?? (await this.upnp.discover());
    if (!gw) throw new Error('No router answered. UPnP may be switched off in the router, or the router does not support it. Forward the port by hand (see the steps below).');
    this.gateway = gw;
    const client = await (this.tools.localAddress ?? localAddressFor)(gw.host);
    if (!client) throw new Error('Could not find out this machine\'s address on the network of the router');
    try {
      await this.upnp.open(gw, port, client);
    } catch (err) {
      this.lastError = (err as Error).message;
      throw new Error(`The router refused the mapping: ${this.lastError}`);
    }
    const now = Date.now();
    this.lastError = null;
    this.mapping = { port, router: gw.name, externalIp: await this.upnp.externalIp(gw).catch(() => null), internalClient: client, openedAt: this.mapping?.openedAt ?? now, renewedAt: now };
    if (!this.net.config.ports.upnp) {
      this.net.config.ports.upnp = true;
      saveConfig(this.net.dataDir, this.net.config);
    }
    this.schedule();
    return this.mapping;
  }

  /** Removes the mapping and stops renewing it. */
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const m = this.mapping;
    this.mapping = null;
    if (this.net.config.ports.upnp) {
      this.net.config.ports.upnp = false;
      saveConfig(this.net.dataDir, this.net.config);
    }
    if (m && this.gateway) await this.upnp.close(this.gateway, m.port).catch((err: Error) => void (this.lastError = err.message));
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh(), this.tools.renewMs ?? 30 * 60_000);
    this.timer.unref();
  }

  /** Renews the mapping, and moves it when the proxy got another port. Problems are remembered, not thrown. */
  async refresh(): Promise<void> {
    if (!this.mapping) return;
    const old = this.mapping.port;
    try {
      if (this.port !== null && this.port !== old && this.gateway) await this.upnp.close(this.gateway, old).catch(() => undefined);
      await this.open();
    } catch (err) {
      this.lastError = (err as Error).message;
    }
  }

  /** Opens the port again when the config says it should be open (after a restart of the daemon). */
  async start(): Promise<void> {
    if (!this.net.config.ports.upnp || this.port === null) return;
    await this.open().catch((err: Error) => void (this.lastError = err.message));
  }

  /** The daemon is stopping: give the port back to the router. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.mapping && this.gateway) await this.upnp.close(this.gateway, this.mapping.port).catch(() => undefined);
    this.mapping = null; // the config keeps "upnp: true", so the next start opens it again
  }

  /** Asks an outside service to try the proxy's port (sends the public address and port there). */
  async check(): Promise<ReachResult> {
    const port = this.port;
    if (port === null) throw new Error('There is no proxy yet');
    const fetchFn = this.tools.fetch ?? realFetch;
    const ip = this.mapping?.externalIp ?? (await publicIp(fetchFn));
    if (isPrivateAddress(ip)) {
      return { ip, port, online: false, version: null, motd: null, hints: ['The address your router reports is not a public one: your internet provider probably shares one address between customers (CGNAT). Port forwarding cannot work then; ask the provider for a public address or use a tunnel service.'] };
    }
    return checkFromInternet(ip, port, fetchFn);
  }
}
