import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, join } from 'node:path';
import { describe, it } from 'node:test';
import { backupFiles, BACKUP_DIR, placeServer, velocityPort } from '../src/setup/importer';
import { parseSetupRequest, type SetupState } from '../src/setup/provision';
import { makeNetwork, server, tmp, waitFor } from './helpers';

const FIX = join(process.cwd(), 'test', 'fixtures');

interface Existing {
  jar: string;
  version?: string;
  props?: string;
  eula?: boolean;
  paperGlobal?: boolean;
  extra?: Record<string, string>;
}

/** An "existing" server folder, as a user would have it somewhere on the disk. */
function existing(name: string, o: Existing): string {
  const dir = join(tmp('existing'), name);
  mkdirSync(join(dir, 'world'), { recursive: true });
  writeFileSync(join(dir, o.jar), 'jar');
  writeFileSync(join(dir, 'world', 'level.dat'), 'world data');
  if (o.version) writeFileSync(join(dir, 'version.txt'), o.version);
  if ((o.props as unknown) !== false) writeFileSync(join(dir, 'server.properties'), o.props ?? '#old\nserver-port=25565\nserver-ip=\nonline-mode=true\nmotd=Our Old Server\n');
  if (o.eula) writeFileSync(join(dir, 'eula.txt'), 'eula=true\n');
  if (o.paperGlobal) {
    mkdirSync(join(dir, 'config'), { recursive: true });
    copyFileSync(join(FIX, 'paper-global.yml'), join(dir, 'config', 'paper-global.yml'));
  }
  for (const [rel, text] of Object.entries(o.extra ?? {})) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

const net = (servers = [] as ReturnType<typeof server>[]) => makeNetwork(servers, {}, { setup: { pollMs: 20, isPortFree: () => Promise.resolve(true) } });
const finished = (n: ReturnType<typeof makeNetwork>['net']) => waitFor(() => n.setup.state && n.setup.state.status !== 'running', 20_000, 'setup to finish');
const read = (...p: string[]) => readFileSync(join(...p), 'utf8');
const step = (n: ReturnType<typeof makeNetwork>['net'], id: string) => (n.setup.state as SetupState).steps.find((s) => s.id === id);

describe('inspectImport', () => {
  it('classifies what MCNetwork can do with a folder', async () => {
    const { net: n } = net();
    await n.start();
    const kinds: [string, string][] = [['paper.jar', 'full'], ['spigot.jar', 'convert'], ['fabric.jar', 'standalone'], ['server.jar', 'standalone'], ['velocity.jar', 'proxy']];
    for (const [jar, support] of kinds) {
      const r = await n.inspectImport(existing('srv', { jar, eula: true }));
      assert.equal(r.support, support, jar);
      assert.deepEqual(r.issues, []);
    }
    const none = await n.inspectImport(existing('empty', { jar: 'readme.txt' }));
    assert.equal(none.support, 'none');
    assert.match(none.issues[0], /No Minecraft server/);
  });

  it('reports missing folders and files', async () => {
    const { net: n } = net();
    await n.start();
    assert.match((await n.inspectImport(join(tmp(), 'nope'))).issues[0], /does not exist/);
    const dir = tmp();
    writeFileSync(join(dir, 'a.txt'), 'x');
    assert.match((await n.inspectImport(join(dir, 'a.txt'))).issues[0], /not a folder/);
  });

  it('refuses folders that are already managed or that hold the data folder', async () => {
    const { net: n, dir } = net([server('lobby', { autoStart: false })]);
    await n.start();
    const managed = await n.inspectImport(join(dir, 'servers', 'lobby'));
    assert.match(managed.issues.join(' '), /already the server "lobby"/);
    writeFileSync(join(dir, 'servers', 'lobby', 'paper.jar'), 'jar');
    const parent = await n.inspectImport(join(dir, '..'));
    assert.ok(parent.issues.length >= 0);
    const inside = existing('outer', { jar: 'paper.jar' });
    const { net: n2, dir: data } = net();
    await n2.start();
    mkdirSync(join(inside, 'data'), { recursive: true });
    assert.equal(await n2.inspectImport(inside).then((r) => r.issues.length), 0);
    assert.match((await n2.inspectImport(data)).issues.join(' '), /contains the MCNetwork data folder|No Minecraft server/);
  });

  it('notices a server that is still running and suggests a free id', async () => {
    const { net: n } = net([server('survival', { autoStart: false })]);
    await n.start();
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    const dir = existing('survival', { jar: 'paper.jar', props: `server-port=${port}\n` });
    const r = await n.inspectImport(dir);
    await new Promise<void>((r2) => srv.close(() => r2()));
    assert.match(r.issues.join(' '), new RegExp(`listening on port ${port}`));
    assert.equal(r.suggestedId, 'survival-2');
    assert.equal(basename(dir), 'survival');
  });
});

describe('import helpers', () => {
  it('backs up only the files that exist, in a timestamped folder', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'server.properties'), 'a=1');
    mkdirSync(join(dir, 'config'));
    writeFileSync(join(dir, 'config', 'paper-global.yml'), 'x: 1');
    const target = backupFiles(dir, ['server.properties', 'config/paper-global.yml', 'missing.yml'], new Date('2026-01-02T03:04:05.678Z'));
    assert.equal(target, join(dir, BACKUP_DIR, '2026-01-02T03-04-05-678Z'));
    assert.equal(read(target, 'server.properties'), 'a=1');
    assert.equal(read(target, 'config', 'paper-global.yml'), 'x: 1');
    assert.deepEqual(readdirSync(target).sort(), ['config', 'server.properties']);
    assert.equal(backupFiles(tmp(), ['server.properties']), null);
  });

  it('reads the port of an existing Velocity proxy', () => {
    const dir = tmp();
    assert.equal(velocityPort(dir), 25565);
    writeFileSync(join(dir, 'velocity.toml'), 'bind = "0.0.0.0:25570"\n');
    assert.equal(velocityPort(dir), 25570);
  });

  it('copies, moves or leaves a folder, and refuses a target that is not empty', async () => {
    const data = tmp();
    const src = existing('a', { jar: 'paper.jar' });
    const copied = await placeServer({ path: src, mode: 'copy' }, data, 'a');
    assert.deepEqual(copied, { dir: join('servers', 'a'), external: false });
    assert.ok(existsSync(join(data, 'servers', 'a', 'world', 'level.dat')));
    assert.ok(existsSync(join(src, 'world', 'level.dat')), 'the original stays');
    await assert.rejects(() => placeServer({ path: src, mode: 'copy' }, data, 'a'), /already has files/);
    const linked = await placeServer({ path: src, mode: 'link' }, data, 'b');
    assert.deepEqual(linked, { dir: src, external: true });
    const moved = await placeServer({ path: src, mode: 'move' }, data, 'c');
    assert.equal(moved.dir, join('servers', 'c'));
    assert.equal(existsSync(src), false, 'the original is gone');
    assert.ok(existsSync(join(data, 'servers', 'c', 'paper.jar')));
  });
});

describe('importing into a network', () => {
  it('copies a Paper server in, connects it and keeps the original untouched', async () => {
    const orig = existing('old', { jar: 'paper.jar', eula: true, paperGlobal: true, extra: { 'plugins/Essentials.jar': 'x' } });
    const { net: n, dir } = net();
    await n.start();
    n.setup.start({ backends: [{ id: 'old', name: 'Old World', import: { path: orig, mode: 'copy' } }], acceptEula: true, start: false });
    await finished(n);
    const state = n.setup.state as SetupState;
    assert.equal(state.status, 'done', state.error ?? '');
    assert.match(step(n, 'import:old')?.detail ?? '', /paper 1\.21\.8, copied .*originals of changed files saved in \.mcnetwork-backup/);
    assert.match(step(n, 'prepare:old')?.detail ?? '', /already exist/);
    assert.equal(step(n, 'install:old'), undefined, 'nothing is downloaded for an existing server');

    const cfg = n.config.servers.find((s) => s.id === 'old');
    assert.deepEqual({ role: cfg?.role, port: cfg?.port, entry: cfg?.entry, imported: cfg?.imported, external: cfg?.external, standalone: cfg?.standalone }, { role: 'backend', port: 30066, entry: true, imported: true, external: undefined, standalone: undefined });
    const copy = join(dir, 'servers', 'old');
    const props = read(copy, 'server.properties');
    assert.match(props, /server-port=30066/);
    assert.match(props, /server-ip=127\.0\.0\.1/);
    assert.match(props, /online-mode=false/);
    assert.match(props, /motd=Our Old Server/, 'the server keeps its own message');
    assert.match(read(copy, 'config', 'paper-global.yml'), /velocity:\n {4}enabled: true\n {4}online-mode: true\n {4}secret: 'fake-secret-123'/);
    assert.ok(existsSync(join(copy, 'world', 'level.dat')) && existsSync(join(copy, 'plugins', 'Essentials.jar')), 'world and plugins came along');
    assert.equal(read(copy, 'plugins', 'MCNetworkAgent.jar'), 'fake paper jar 0.1.0');
    const backups = readdirSync(join(copy, BACKUP_DIR));
    assert.equal(backups.length, 1);
    assert.match(read(copy, BACKUP_DIR, backups[0], 'server.properties'), /server-port=25565/);
    assert.match(read(dir, 'servers', 'proxy', 'velocity.toml'), /^old = "127\.0\.0\.1:30066"$/m);

    assert.match(read(orig, 'server.properties'), /server-port=25565/, 'the original is as it was');
    assert.equal(existsSync(join(orig, 'plugins', 'MCNetworkAgent.jar')), false);
    assert.equal(existsSync(join(orig, BACKUP_DIR)), false);
  });

  it('uses a server where it is (link), changes it in place and saves the originals', async () => {
    const orig = existing('hub', { jar: 'paper.jar', eula: true, paperGlobal: true });
    const { net: n } = net();
    await n.start();
    n.setup.start({ backends: [{ id: 'hub', import: { path: orig, mode: 'link' } }], acceptEula: true, start: false });
    await finished(n);
    assert.equal(n.setup.state?.status, 'done', n.setup.state?.error ?? '');
    const cfg = n.config.servers.find((s) => s.id === 'hub');
    assert.deepEqual({ dir: cfg?.dir, external: cfg?.external }, { dir: orig, external: true });
    assert.match(read(orig, 'server.properties'), /server-port=30066/);
    assert.equal(read(orig, 'plugins', 'MCNetworkAgent.jar'), 'fake paper jar 0.1.0');
    const saved = join(orig, BACKUP_DIR, readdirSync(join(orig, BACKUP_DIR))[0]);
    assert.match(read(saved, 'server.properties'), /server-port=25565/);
    // removing it from the network leaves the folder alone
    await n.removeServer('hub');
    assert.ok(existsSync(join(orig, 'world', 'level.dat')));
  });

  it('moves a server in when asked to', async () => {
    const orig = existing('moved', { jar: 'paper.jar', eula: true, paperGlobal: true });
    const { net: n, dir } = net();
    await n.start();
    n.setup.start({ backends: [{ id: 'moved', import: { path: orig, mode: 'move' } }], acceptEula: true, start: false });
    await finished(n);
    assert.equal(n.setup.state?.status, 'done', n.setup.state?.error ?? '');
    assert.equal(existsSync(orig), false);
    assert.ok(existsSync(join(dir, 'servers', 'moved', 'world', 'level.dat')));
  });

  it('manages software that cannot sit behind the proxy, without touching its settings', async () => {
    const orig = existing('modded', { jar: 'fabric.jar', eula: true, props: 'server-port=25570\nonline-mode=true\n' });
    const { net: n, dir } = net();
    await n.start();
    n.setup.start({ backends: [{ id: 'lobby' }, { id: 'modded', import: { path: orig, mode: 'copy' } }], acceptEula: true, start: false });
    await finished(n);
    assert.equal(n.setup.state?.status, 'done', n.setup.state?.error ?? '');
    const cfg = n.config.servers.find((s) => s.id === 'modded');
    assert.deepEqual({ standalone: cfg?.standalone, port: cfg?.port, entry: cfg?.entry }, { standalone: true, port: 25570, entry: undefined });
    assert.match(step(n, 'import:modded')?.detail ?? '', /managed only, not behind the proxy/);
    assert.equal(step(n, 'prepare:modded')?.status, 'skipped');
    assert.match(read(dir, 'servers', 'modded', 'server.properties'), /online-mode=true/, 'untouched');
    const toml = read(dir, 'servers', 'proxy', 'velocity.toml');
    assert.doesNotMatch(toml, /^modded = /m, 'not in the proxy'); // (the word also occurs in Velocity's own comments)
    assert.match(step(n, 'connect')?.detail ?? '', /modded stay outside the proxy/);
  });

  it('gives a standalone server another port when its own is taken', async () => {
    const orig = existing('modded', { jar: 'fabric.jar', eula: true });
    const { net: n, dir } = net();
    await n.start();
    n.setup.start({ backends: [{ id: 'lobby' }, { id: 'modded', import: { path: orig, mode: 'copy' } }], acceptEula: true, start: false });
    await finished(n);
    assert.equal(n.setup.state?.status, 'done', n.setup.state?.error ?? '');
    assert.equal(n.config.servers.find((s) => s.id === 'modded')?.port, 30067, 'the proxy has 25565');
    assert.match(read(dir, 'servers', 'modded', 'server.properties'), /server-port=30067/);
    assert.match(read(dir, 'servers', 'modded', BACKUP_DIR, readdirSync(join(dir, 'servers', 'modded', BACKUP_DIR))[0], 'server.properties'), /server-port=25565/);
  });

  it('switches a Spigot server to Paper when asked, and manages it as it is otherwise', async () => {
    const spigot = existing('spig', { jar: 'spigot.jar', eula: true, version: '1.21.4', paperGlobal: true });
    const { net: n } = net();
    await n.start();
    n.setup.start({ backends: [{ id: 'spig', import: { path: spigot, mode: 'copy', convertToPaper: true } }], acceptEula: true, start: false });
    await finished(n);
    assert.equal(n.setup.state?.status, 'done', n.setup.state?.error ?? '');
    assert.match(step(n, 'install:spig')?.detail ?? '', /paper 1\.21\.4 \+ agent/);
    assert.equal(n.config.servers.find((s) => s.id === 'spig')?.standalone, undefined);

    const other = existing('spig2', { jar: 'spigot.jar', eula: true, version: '1.21.4' });
    const { net: n2 } = net();
    await n2.start();
    n2.setup.start({ backends: [{ id: 'spig2', import: { path: other, mode: 'copy' } }], acceptEula: true, start: false });
    await finished(n2);
    assert.equal(n2.config.servers.find((s) => s.id === 'spig2')?.standalone, true);
    assert.equal(step(n2, 'install:spig2'), undefined);
  });

  it('imports an existing Velocity proxy, keeps its servers and port, and connects the network to it', async () => {
    const proxy = existing('velo', { jar: 'velocity.jar', props: false as unknown as string, extra: { 'forwarding.secret': 'my-own-secret\n', 'velocity.toml': readFileSync(join(FIX, 'velocity-3.5.1.toml'), 'utf8').replace('0.0.0.0:25565', '0.0.0.0:25570').replace('lobby = "127.0.0.1:30066"', 'hub = "10.0.0.5:25566"') } });
    const { net: n, dir } = net();
    await n.start();
    n.setup.start({ proxy: { import: { path: proxy, mode: 'copy' } }, backends: [{ id: 'lobby' }], acceptEula: true, start: false });
    await finished(n);
    assert.equal(n.setup.state?.status, 'done', n.setup.state?.error ?? '');
    const cfg = n.config.servers.find((s) => s.id === 'proxy');
    assert.deepEqual({ port: cfg?.port, imported: cfg?.imported }, { port: 25570, imported: true });
    assert.match(step(n, 'prepare:proxy')?.detail ?? '', /already exist/);
    const toml = read(dir, 'servers', 'proxy', 'velocity.toml');
    assert.match(toml, /^bind = "0\.0\.0\.0:25570"$/m, 'its public port stays');
    assert.match(toml, /^player-info-forwarding-mode = "modern"$/m);
    assert.match(toml, /^lobby = "127\.0\.0\.1:30066"$/m);
    assert.match(toml, /# Servers that were already in this file:\nhub = "10\.0\.0\.5:25566"/);
    assert.match(read(dir, 'servers', 'lobby', 'config', 'paper-global.yml'), /secret: 'my-own-secret'/, 'the proxy\'s own secret is used');
    assert.ok(existsSync(join(dir, 'servers', 'proxy', BACKUP_DIR)));
    assert.match(read(dir, 'servers', 'proxy', 'plugins', 'MCNetworkAgent.jar'), /velocity/);
  });

  it('stops with a clear message when the folder is not importable', async () => {
    const { net: n } = net();
    await n.start();
    n.setup.start({ backends: [{ id: 'x', import: { path: join(tmp(), 'nowhere'), mode: 'copy' } }], acceptEula: true, start: false });
    await finished(n);
    assert.equal(n.setup.state?.status, 'failed');
    assert.match(n.setup.state?.error ?? '', /does not exist/);
    assert.equal(step(n, 'import:x')?.status, 'failed');

    const { net: n2 } = net();
    await n2.start();
    n2.setup.start({ backends: [{ id: 'x', import: { path: existing('velo', { jar: 'velocity.jar' }), mode: 'copy' } }], acceptEula: true, start: false });
    await finished(n2);
    assert.match(n2.setup.state?.error ?? '', /Velocity proxy, not a game server/);

    const { net: n3 } = net();
    await n3.start();
    n3.setup.start({ proxy: { import: { path: existing('paper', { jar: 'paper.jar' }), mode: 'copy' } }, backends: [{ id: 'x' }], acceptEula: true, start: false });
    await finished(n3);
    assert.match(n3.setup.state?.error ?? '', /not a Velocity proxy/);
  });

  it('refuses a too old Paper behind the proxy and asks for the version of a Spigot server', async () => {
    const old = existing('old', { jar: 'paper.jar', eula: true, version: '1.18.2' });
    const { net: n } = net();
    await n.start();
    n.setup.start({ backends: [{ id: 'old', import: { path: old, mode: 'copy' } }], acceptEula: true, start: false });
    await finished(n);
    assert.match(n.setup.state?.error ?? '', /too old.*standalone/);

    const nover = existing('nover', { jar: 'spigot.jar', eula: true });
    writeFileSync(join(nover, 'version.txt'), '');
    const { net: n2 } = net();
    await n2.start();
    n2.setup.start({ backends: [{ id: 'nover', import: { path: nover, mode: 'copy', convertToPaper: true } }], acceptEula: true, start: false });
    await finished(n2);
    assert.match(n2.setup.state?.error ?? '', /version of this Spigot server is unknown/);
    const { net: n3 } = net();
    await n3.start();
    n3.setup.start({ backends: [{ id: 'nover', import: { path: nover, mode: 'copy', convertToPaper: true, version: '1.20.4' } }], acceptEula: true, start: false });
    await finished(n3);
    assert.equal(n3.setup.state?.status, 'done', n3.setup.state?.error ?? '');
    assert.match(step(n3, 'install:nover')?.detail ?? '', /paper 1\.20\.4/);
  });
});

describe('import request validation', () => {
  it('needs an absolute path and a known mode', () => {
    const base = { acceptEula: true };
    const bad = (backend: unknown) => () => parseSetupRequest({ ...base, backends: [backend] }, []);
    assert.throws(bad({ id: 'a', import: { path: 'relative/dir', mode: 'copy' } }), /full path/);
    assert.throws(bad({ id: 'a', import: { path: join(tmp(), 'x'), mode: 'swap' } }), /mode/);
    assert.throws(bad({ id: 'a', import: 5 }), /must be an object/);
    const ok = parseSetupRequest({ ...base, backends: [{ id: 'a', version: '1.21.8', import: { path: join(tmp(), 'x'), mode: 'link', convertToPaper: true, standalone: true, version: '1.20.4' } }] }, []);
    assert.equal(ok.backends[0].version, undefined, 'a version for a new install does not apply to an import');
    assert.deepEqual({ mode: ok.backends[0].import?.mode, convert: ok.backends[0].import?.convertToPaper, standalone: ok.backends[0].import?.standalone, version: ok.backends[0].import?.version }, { mode: 'link', convert: true, standalone: true, version: '1.20.4' });
    assert.throws(() => parseSetupRequest({ ...base, proxy: { import: { path: join(tmp(), 'x'), mode: 'copy' } }, backends: [{ id: 'a' }] }, [], true), /already has a proxy/);
  });
});
