// A stand-in for `mcli.js --api` that speaks the same line protocol (see MCLI docs/API.md).
// FAKE_EXIT_AT_START=1 exits immediately, FAKE_CRASH_MS=<n> exits <n> ms after "ready".
import { appendFileSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const MB = 1024 * 1024;
let state = 'stopped';
let min = '1G';
let max = '2G';
let startedAt: number | null = null;
const players = new Set<string>();
let installed: string | null = 'generic'; // something is installed until install() says otherwise
const FIX = join(__dirname, '..', '..', 'test', 'fixtures');

/** What a real first start leaves behind, so the setup code has real-looking files to patch. */
function writeFirstStartFiles(): void {
  if (process.env.FAKE_NO_FILES) return;
  if (installed === 'velocity') {
    if (!existsSync('velocity.toml')) copyFileSync(join(FIX, 'velocity-3.5.1.toml'), 'velocity.toml');
    if (!existsSync('forwarding.secret')) writeFileSync('forwarding.secret', 'fake-secret-123\n');
  } else if (installed === 'paper' && !existsSync(join('config', 'paper-global.yml'))) {
    mkdirSync('config', { recursive: true });
    copyFileSync(join(FIX, 'paper-global.yml'), join('config', 'paper-global.yml'));
  }
}

const out = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');
const setState = (s: string) => {
  state = s;
  out({ event: 'state', data: { state } });
};

const status = () => ({
  mcli: 'fake',
  protocol: 1,
  dir: process.cwd(),
  state,
  pid: state === 'stopped' ? null : process.pid,
  startedAt,
  uptimeMs: startedAt ? Date.now() - startedAt : 0,
  restarts: 0,
  software: { type: 'paper', version: '1.21.8', jar: 'paper.jar', build: '60' },
  java: 'java',
  memory: { min, max, systemTotal: 8 * 1024 * MB, time: Date.now(), sysCpu: 1, sysMemPercent: 10, procRss: state === 'stopped' ? 0 : 600 * MB, procCpu: 2 },
  players: { count: players.size, max: 20, online: [...players].map((name) => ({ name, since: 0 })) },
  health: { reachable: state === 'running' ? true : null },
  problems: [],
  installer: { busy: null, progress: null },
  backups: { busy: null, lastAt: null },
  updates: null,
});

const memoryRe = /^(\d+)[MG]$/i;

function handle(method: string, p: Record<string, unknown>): unknown {
  switch (method) {
    case 'status':
      return status();
    case 'start':
      if (state !== 'stopped') return { state, problems: [] };
      if (installed === 'paper' && !existsSync('eula.txt')) return { state, problems: [{ id: 'eula', title: 'The Minecraft EULA is not accepted', advice: 'Accept it', fatal: true }] };
      if (!installed) return { state, problems: [{ id: 'no-server', title: 'No server found', advice: 'Install one', fatal: true }] };
      startedAt = Date.now();
      setState('starting');
      setTimeout(writeFirstStartFiles, 100);
      setTimeout(() => setState('running'), 30);
      return { state, problems: [] };
    case 'stop':
      setState('stopped');
      startedAt = null;
      players.clear();
      return { state };
    case 'restart':
      return handle('stop', p) && handle('start', p);
    case 'setMemory': {
      const nextMin = typeof p.min === 'string' ? p.min : min;
      const nextMax = typeof p.max === 'string' ? p.max : max;
      if (!memoryRe.test(nextMin) || !memoryRe.test(nextMax)) throw new Error('Memory must look like "512M" or "2G"');
      min = nextMin;
      max = nextMax;
      return { min, max, appliesOnNextStart: state !== 'stopped' };
    }
    case 'command':
      if (state === 'stopped') return false;
      appendFileSync('commands.log', `${String(p.text)}\n`);
      if (p.text === 'join Steve') players.add('Steve');
      return true;
    case 'logs':
      return [{ time: Date.now(), text: 'hello', src: 'server' }];
    case 'players':
      return status().players;
    case 'versions':
      return p.provider === 'velocity' ? ['4.3.1', '3.5.1'] : ['1.21.8', '1.21.7'];
    case 'plan':
      return { provider: p.provider, version: p.version, build: '1', channel: p.provider === 'velocity' && p.version === '3.5.1' ? 'RECOMMENDED' : 'STABLE', javaMajor: 21, filename: 'x.jar', size: 1, display: 'x' };
    case 'install':
      if (p.version === '0.0') return false;
      installed = String(p.provider);
      return true;
    case 'acceptEula':
      writeFileSync('eula.txt', 'eula=true\n');
      return true;
    case 'shutdown':
      process.exit(0);
      return true;
    default:
      throw new Error(`Unknown method "${method}"`);
  }
}

if (process.env.FAKE_EXIT_AT_START) process.exit(3);
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const req = JSON.parse(line) as { id: number; method: string; params?: Record<string, unknown> };
  if (req.method === 'hang') return; // never answers
  try {
    out({ id: req.id, ok: true, result: handle(req.method, req.params ?? {}) });
  } catch (err) {
    out({ id: req.id, ok: false, error: (err as Error).message });
  }
});
rl.on('close', () => process.exit(0));
out({ event: 'ready', data: { mcli: 'fake', protocol: 1, dir: process.cwd() } });
if (process.env.FAKE_CRASH_MS) setTimeout(() => process.exit(1), Number(process.env.FAKE_CRASH_MS));
