/** Separates the servers MCNetwork writes from the ones an imported proxy already had. */
const KEPT_MARKER = '# Servers that were already in this file:';

const tomlString = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export interface VelocitySettings {
  bind?: string;
  motd?: string;
  /** "modern" is the safe choice for Minecraft 1.13+ backends. */
  forwardingMode?: 'none' | 'legacy' | 'bungeeguard' | 'modern';
  /** Name -> "host:port". Replaces whatever [servers] contained (including Velocity's example servers). */
  servers: Record<string, string>;
  /** Servers players join first, in order. */
  tryOrder: string[];
  /** Keep the servers the file already lists (an imported proxy) and add the network's servers to them. */
  keepServers?: boolean;
}

/** Sets `key = value` before the first [section]; adds the key when it is missing. */
function setTopLevel(lines: string[], key: string, value: string): void {
  const firstSection = lines.findIndex((l) => l.startsWith('['));
  const top = firstSection < 0 ? lines.length : firstSection;
  const re = new RegExp(`^${key}\\s*=`);
  for (let i = 0; i < top; i++) {
    if (re.test(lines[i])) {
      lines[i] = `${key} = ${value}`;
      return;
    }
  }
  lines.splice(top, 0, `${key} = ${value}`, '');
}

/** [start, end) of the body of a [section] (the lines after its header up to the next header). */
function sectionBody(lines: string[], name: string): [number, number] | null {
  const header = lines.findIndex((l) => l.trim() === `[${name}]`);
  if (header < 0) return null;
  let end = lines.findIndex((l, i) => i > header && l.startsWith('['));
  if (end < 0) end = lines.length;
  return [header + 1, end];
}

/**
 * Applies the network layout to a velocity.toml. The file is the one Velocity generated on its first
 * start, so unknown and future keys stay untouched. Velocity's example servers and forced hosts are
 * removed, because forced hosts pointing at servers that do not exist make the proxy complain.
 */
export function patchVelocityToml(text: string, s: VelocitySettings): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (s.bind) setTopLevel(lines, 'bind', tomlString(s.bind));
  if (s.motd !== undefined) setTopLevel(lines, 'motd', tomlString(s.motd));
  if (s.forwardingMode) setTopLevel(lines, 'player-info-forwarding-mode', tomlString(s.forwardingMode));

  const servers = sectionBody(lines, 'servers');
  const kept: string[] = [];
  const keptTry: string[] = [];
  if (s.keepServers && servers) {
    const body = lines.slice(servers[0], servers[1]);
    // after our first rewrite, only the lines below the marker are the user's own; before it, everything is
    const marker = body.findIndex((l) => l.trim() === KEPT_MARKER);
    const own = marker >= 0 ? body.slice(marker + 1) : body;
    for (const line of own) {
      const m = /^\s*("?[\w.-]+"?)\s*=\s*"([^"]*)"\s*(#.*)?$/.exec(line);
      if (m && m[1] !== 'try' && !(m[1].replace(/"/g, '') in s.servers)) kept.push(line.trim());
    }
    const keptNames = kept.map((l) => /^"?([\w.-]+)"?/.exec(l)?.[1] ?? '');
    const t = /^\s*try\s*=\s*\[([^\]]*)\]/m.exec(body.join('\n'));
    for (const n of ((t?.[1] ?? '').match(/"([^"]+)"/g) ?? []).map((x) => x.replace(/"/g, ''))) if (!s.tryOrder.includes(n) && keptNames.includes(n)) keptTry.push(n);
  }
  const block = [
    '# Managed by MCNetwork: edit the servers in the dashboard.',
    ...Object.entries(s.servers).map(([name, addr]) => `${name} = ${tomlString(addr)}`),
    ...(kept.length ? [KEPT_MARKER, ...kept] : []),
    '',
    `try = [${[...s.tryOrder, ...keptTry].map((n) => tomlString(n)).join(', ')}]`,
    '',
  ];
  if (servers) lines.splice(servers[0], servers[1] - servers[0], ...block);
  else lines.push('', '[servers]', ...block);

  const forced = sectionBody(lines, 'forced-hosts');
  if (forced) lines.splice(forced[0], forced[1] - forced[0], '# Forced hosts can be added here.', '');
  return lines.join('\n').replace(/\n*$/, '\n');
}
