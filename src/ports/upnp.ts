import { createSocket } from 'node:dgram';
import { request } from 'node:http';
import { URL } from 'node:url';

/** A router that offers UPnP port mapping (an "Internet Gateway Device"). */
export interface Gateway {
  /** Name the router gives itself. */
  name: string;
  /** Address of the router. */
  host: string;
  /** Full URL of the control endpoint. */
  controlUrl: string;
  /** e.g. urn:schemas-upnp-org:service:WANIPConnection:1 */
  serviceType: string;
}

export interface UpnpOptions {
  /** Where discovery messages go (test hook; the real value is the UPnP multicast group). */
  ssdpHost?: string;
  ssdpPort?: number;
  /** How long to wait for an answer to the discovery. */
  timeoutMs?: number;
}

const SEARCH_TARGETS = ['urn:schemas-upnp-org:device:InternetGatewayDevice:1', 'urn:schemas-upnp-org:device:InternetGatewayDevice:2'];
const WAN_SERVICES = ['WANIPConnection:2', 'WANIPConnection:1', 'WANPPPConnection:1'];

export class UpnpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

/** GET or POST with a timeout; resolves with status and body. */
function http(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs: number }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: opts.method ?? 'GET', headers: opts.headers, timeout: opts.timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('the router did not answer in time')));
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

const tag = (xml: string, name: string): string | undefined => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1]?.trim();

/** Finds the WAN connection service in a device description. */
export function parseDescription(xml: string, location: string): Omit<Gateway, 'host'> | null {
  const base = tag(xml, 'URLBase') || location;
  for (const wanted of WAN_SERVICES) {
    for (const block of xml.match(/<service>[\s\S]*?<\/service>/g) ?? []) {
      const type = tag(block, 'serviceType');
      const control = tag(block, 'controlURL');
      if (type?.endsWith(wanted) && control) return { name: tag(xml, 'friendlyName') ?? 'Router', controlUrl: new URL(control, base).toString(), serviceType: type };
    }
  }
  return null;
}

function soapBody(serviceType: string, action: string, args: Record<string, string | number>): string {
  const inner = Object.entries(args).map(([k, v]) => `<${k}>${String(v).replace(/[<>&]/g, '')}</${k}>`).join('');
  return `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${serviceType}">${inner}</u:${action}></s:Body></s:Envelope>`;
}

/** UPnP port mapping without dependencies: SSDP discovery, then SOAP calls to the router. */
export class Upnp {
  constructor(private opts: UpnpOptions = {}) {}

  private get timeoutMs(): number {
    return this.opts.timeoutMs ?? 2500;
  }

  /** Looks for a router that supports port mapping; null when nothing answers. */
  discover(): Promise<Gateway | null> {
    return new Promise((resolve) => {
      const socket = createSocket('udp4');
      let done = false;
      const finish = (gw: Gateway | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(gw);
      };
      const timer = setTimeout(() => finish(null), this.timeoutMs);
      socket.on('error', () => finish(null));
      socket.on('message', (msg, rinfo) => {
        const location = /^location:\s*(\S+)/im.exec(msg.toString('utf8'))?.[1];
        if (!location) return;
        http(location, { timeoutMs: this.timeoutMs })
          .then((r) => {
            const d = parseDescription(r.body, location);
            if (d) finish({ ...d, host: rinfo.address });
          })
          .catch(() => undefined); // another device may answer better
      });
      socket.bind(0, () => {
        for (const st of SEARCH_TARGETS) {
          const text = `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`;
          socket.send(text, this.opts.ssdpPort ?? 1900, this.opts.ssdpHost ?? '239.255.255.250', () => undefined);
        }
      });
    });
  }

  private async call(gw: Gateway, action: string, args: Record<string, string | number> = {}): Promise<string> {
    const res = await http(gw.controlUrl, {
      method: 'POST',
      timeoutMs: this.timeoutMs,
      headers: { 'content-type': 'text/xml; charset="utf-8"', soapaction: `"${gw.serviceType}#${action}"` },
      body: soapBody(gw.serviceType, action, args),
    });
    if (res.status !== 200) {
      const code = Number(tag(res.body, 'errorCode'));
      throw new UpnpError(tag(res.body, 'errorDescription') ?? `the router answered ${res.status}`, Number.isFinite(code) ? code : undefined);
    }
    return res.body;
  }

  /** The address the router has on the internet (may be a private one behind a carrier's NAT). */
  async externalIp(gw: Gateway): Promise<string | null> {
    return tag(await this.call(gw, 'GetExternalIPAddress'), 'NewExternalIPAddress') ?? null;
  }

  /** Forwards a TCP port of the router to this machine. Routers that only know permanent mappings get lease 0. */
  async open(gw: Gateway, port: number, internalClient: string, description = 'MCNetwork', leaseSeconds = 3600): Promise<void> {
    const args = (lease: number) => ({ NewRemoteHost: '', NewExternalPort: port, NewProtocol: 'TCP', NewInternalPort: port, NewInternalClient: internalClient, NewEnabled: 1, NewPortMappingDescription: description, NewLeaseDuration: lease });
    try {
      await this.call(gw, 'AddPortMapping', args(leaseSeconds));
    } catch (err) {
      if (err instanceof UpnpError && err.code === 725) await this.call(gw, 'AddPortMapping', args(0)); // "only permanent leases supported"
      else throw err;
    }
  }

  async close(gw: Gateway, port: number): Promise<void> {
    try {
      await this.call(gw, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: port, NewProtocol: 'TCP' });
    } catch (err) {
      if (!(err instanceof UpnpError && err.code === 714)) throw err; // 714: there was no such mapping
    }
  }
}

/** The address of this machine on the network that leads to `host` (what the router has to forward to). */
export function localAddressFor(host: string): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    socket.on('error', () => {
      socket.close();
      resolve(null);
    });
    socket.connect(9, host, () => {
      const address = socket.address().address;
      socket.close();
      resolve(address);
    });
  });
}

/** True for addresses that cannot be reached from the internet: private ranges and the carrier-grade NAT range 100.64.0.0/10. */
export function isPrivateAddress(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n))) return false;
  return p[0] === 10 || p[0] === 127 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || (p[0] === 169 && p[1] === 254);
}
