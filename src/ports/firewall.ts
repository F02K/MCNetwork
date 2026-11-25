import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

export type FirewallTool = 'ufw' | 'firewalld' | 'iptables' | 'windows' | 'macos' | null;

export interface FirewallInfo {
  platform: string;
  tool: FirewallTool;
  /** true/false when it could be read without special rights, null when unknown. */
  active: boolean | null;
  /** What to run (as administrator) to let `port` in. Empty when no tool was found. */
  commands: string[];
  note: string | null;
}

export interface LanAddress {
  name: string;
  address: string;
}

/** Runs a program and gives its output, or null when it is missing or fails (replaceable in tests). */
export type Run = (cmd: string, args: string[]) => Promise<string | null>;

export const runProgram: Run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 4000, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout));
  });

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
      return [`netsh advfirewall firewall add rule name="MCNetwork ${port}" dir=in action=allow protocol=TCP localport=${port}`];
    default:
      return [];
  }
}

/** Which firewall this machine uses and how to open a port in it. Nothing is changed. */
export async function detectFirewall(port: number, run: Run = runProgram, platform: string = process.platform, inContainer = existsSync('/.dockerenv')): Promise<FirewallInfo> {
  let tool: FirewallTool = null;
  let active: boolean | null = null;
  if (platform === 'win32') {
    tool = 'windows';
    const out = await run('netsh', ['advfirewall', 'show', 'currentprofile', 'state']);
    active = out === null ? null : /\bON\b/i.test(out);
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
  return { platform, tool, active, commands: openCommands(tool, port), note };
}

/** IPv4 addresses of this machine on its networks: what a router forwards to. */
export function lanAddresses(): LanAddress[] {
  const out: LanAddress[] = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
  }
  return out;
}
