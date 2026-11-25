import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

export type FirewallTool = 'ufw' | 'firewalld' | 'iptables' | 'windows' | 'macos' | null;

export interface FirewallInfo {
  platform: string;
  tool: FirewallTool;
  /** true/false when it could be read without special rights, null when unknown. */
  active: boolean | null;
  /** Windows: an enabled inbound rule already allows this TCP port (null when it could not be checked). */
  portOpen: boolean | null;
  /** What to run (as administrator) to let `port` in. Empty when no tool was found. */
  commands: string[];
  note: string | null;
}

export interface LanAddress {
  name: string;
  address: string;
}

/** Runs a program and gives its output, or null when it is missing or fails (replaceable in tests). */
export type Run = (cmd: string, args: string[], timeoutMs?: number) => Promise<string | null>;

export const runProgram: Run = (cmd, args, timeoutMs = 4000) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout));
  });

const powershell = (run: Run, script: string): Promise<string | null> => run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], 25_000);

/** Lets a TCP port in: PowerShell first (works on every Windows Server), the older netsh as the alternative. */
const windowsCommands = (port: number): string[] => [
  `New-NetFirewallRule -DisplayName "MCNetwork ${port}" -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow`,
  `netsh advfirewall firewall add rule name="MCNetwork ${port}" dir=in action=allow protocol=TCP localport=${port}`,
];

/** True when one of the port lists ("25565", "25000-26000", "1,2,3", "Any") contains the port. "Any" is not counted: it says nothing about this port. */
export function portListHas(values: string[], port: number): boolean {
  for (const v of values) {
    for (const part of v.split(',')) {
      const t = part.trim();
      const range = /^(\d+)-(\d+)$/.exec(t);
      if (range ? port >= Number(range[1]) && port <= Number(range[2]) : Number(t) === port) return true;
    }
  }
  return false;
}

/** Commands that open one TCP port, by firewall. */
export function openCommands(tool: FirewallTool, port: number): string[] {
  switch (tool) {
    case 'ufw':
      return [`sudo ufw allow ${port}/tcp`];
    case 'firewalld':
      return [`sudo firewall-cmd --permanent --add-port=${port}/tcp`, 'sudo firewall-cmd --reload'];
    case 'iptables':
      return [`sudo iptables -I INPUT -p tcp --dport ${port} -j ACCEPT`];
    case 'windows':
      return windowsCommands(port);
    default:
      return [];
  }
}

/** Which firewall this machine uses and how to open a port in it. Nothing is changed. */
export async function detectFirewall(port: number, run: Run = runProgram, platform: string = process.platform, inContainer = existsSync('/.dockerenv')): Promise<FirewallInfo> {
  let tool: FirewallTool = null;
  let active: boolean | null = null;
  let portOpen: boolean | null = null;
  if (platform === 'win32') {
    tool = 'windows';
    // PowerShell answers True/False in every language; netsh prints localised words ("EIN" on a German system)
    const profiles = await powershell(run, "Get-NetFirewallProfile | ForEach-Object { $_.Name + '=' + $_.Enabled }");
    if (profiles !== null && /=(True|False)/i.test(profiles)) active = /=True/i.test(profiles);
    else {
      const netsh = await run('netsh', ['advfirewall', 'show', 'allprofiles', 'state']);
      active = netsh !== null && /(?:^|\s)(ON|EIN|AN|ACTIVADO|ACTIV[ÉE]|ATTIVO|ENABLED)\s*$/im.test(netsh) ? true : null; // unknown stays unknown: never hide the commands on a guess
    }
    const ports = await powershell(run, "Get-NetFirewallRule -Direction Inbound -Enabled True -Action Allow | Get-NetFirewallPortFilter | Where-Object { $_.Protocol -eq 'TCP' } | ForEach-Object { $_.LocalPort }");
    portOpen = ports === null ? null : portListHas(ports.split(/\r?\n/).filter(Boolean), port);
  } else if (platform === 'darwin') {
    tool = 'macos';
  } else {
    if ((await run('ufw', ['version'])) !== null) {
      tool = 'ufw';
      const out = await run('ufw', ['status']);
      active = out === null ? null : /Status:\s*active/i.test(out);
    } else if ((await run('firewall-cmd', ['--version'])) !== null) {
      tool = 'firewalld';
      const out = await run('firewall-cmd', ['--state']);
      active = out === null ? null : /running/i.test(out);
    } else if ((await run('iptables', ['--version'])) !== null) tool = 'iptables';
  }
  let note: string | null = null;
  if (inContainer) note = `MCNetwork runs in a container: publish the port when you start it (for example -p ${port}:${port}); the firewall of the host decides the rest.`;
  else if (tool === 'macos') note = 'macOS asks to allow incoming connections for Java the first time a server starts; there is no port command to run.';
  else if (tool === null) note = 'No firewall program was found. If your system has one, allow TCP port ' + port + ' in it.';
  else if (active === false) note = 'The firewall is switched off, so nothing has to be opened here.';
  else if (tool === 'windows' && portOpen === true) note = `An inbound rule already allows TCP port ${port}.`;
  else if (tool === 'windows') note = 'Run one of the two commands in an elevated PowerShell ("Run as administrator"). A rule is only needed for the proxy port; game servers listen on this machine only.';
  return { platform, tool, active, portOpen, commands: openCommands(tool, port), note };
}

/** IPv4 addresses of this machine on its networks: what a router forwards to. */
export function lanAddresses(): LanAddress[] {
  const out: LanAddress[] = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
  }
  return out;
}
