import { isPrivateAddress } from './upnp';

export interface ReachResult {
  ip: string;
  port: number;
  /** The server answered the check from the internet. */
  online: boolean;
  version: string | null;
  motd: string | null;
  /** What to look at when it is not reachable. */
  hints: string[];
}

export type Fetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export const STATUS_API = 'https://api.mcsrvstat.us/3';
export const IP_API = 'https://api.ipify.org';

/** The address the internet sees for this machine. Asks an outside service, so only on request. */
export async function publicIp(fetchFn: Fetch): Promise<string> {
  const res = await fetchFn(IP_API, { signal: AbortSignal.timeout(6000) });
  const text = (await res.text()).trim();
  if (!res.ok || !/^\d+\.\d+\.\d+\.\d+$/.test(text)) throw new Error('Could not find out the public address');
  return text;
}

/**
 * Asks a public Minecraft status service to ping ip:port from the internet. This sends the address and
 * port to that service, so it is only done when the user asks for it.
 */
export async function checkFromInternet(ip: string, port: number, fetchFn: Fetch): Promise<ReachResult> {
  const res = await fetchFn(`${STATUS_API}/${ip}:${port}`, { headers: { 'user-agent': 'MCNetwork port check' }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`The check service answered ${res.status}`);
  const data = (await res.json()) as { online?: boolean; version?: string; motd?: { clean?: string[] } };
  const online = data.online === true;
  const hints: string[] = [];
  if (!online) {
    if (isPrivateAddress(ip)) hints.push('This address is not public: your internet provider probably shares one address between customers (CGNAT). Port forwarding cannot work then; ask the provider for a public address or use a tunnel service.');
    hints.push('Is the proxy running? (the first step shows it)');
    hints.push('Does the firewall of this machine allow the port?');
    hints.push('Is the router forwarding the TCP port to this machine?');
    hints.push('The check service caches answers for a few minutes; try again after a short wait.');
  }
  return { ip, port, online, version: data.version ?? null, motd: data.motd?.clean?.[0] ?? null, hints };
}
