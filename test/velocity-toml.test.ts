import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { patchVelocityToml } from '../src/setup/velocity';
import { allocatePorts, portFree } from '../src/setup/ports';
import { createServer } from 'node:net';

// the file Velocity 3.5.1 generated on its first start (Git may check it out with CRLF on Windows)
const REAL = readFileSync(join(process.cwd(), 'test', 'fixtures', 'velocity-3.5.1.toml'), 'utf8').replace(/\r\n/g, '\n');
const settings = { bind: '0.0.0.0:25565', forwardingMode: 'modern' as const, servers: { lobby: '127.0.0.1:30066', survival: '127.0.0.1:30067' }, tryOrder: ['lobby'] };

describe('patchVelocityToml (real Velocity 3.5.1 file)', () => {
  const out = patchVelocityToml(REAL, { ...settings, motd: '<green>My "Network"' });

  it('sets bind, motd and the forwarding mode', () => {
    assert.match(out, /^bind = "0\.0\.0\.0:25565"$/m);
    assert.match(out, /^motd = "<green>My \\"Network\\""$/m);
    assert.match(out, /^player-info-forwarding-mode = "modern"$/m);
  });

  it('replaces the example servers and the forced hosts', () => {
    assert.match(out, /\[servers\]\n# Managed by MCNetwork[^\n]*\nlobby = "127\.0\.0\.1:30066"\nsurvival = "127\.0\.0\.1:30067"\n\ntry = \["lobby"\]\n/);
    assert.ok(!out.includes('factions'), 'example servers are gone');
    assert.ok(!out.includes('example.com'), 'example forced hosts are gone');
    assert.match(out, /\[forced-hosts\]\n# Forced hosts can be added here\.\n\n\[advanced\]/);
  });

  it('keeps everything else, including comments and later sections', () => {
    assert.ok(out.includes('config-version = "2.8"'));
    assert.ok(out.includes('forwarding-secret-file = "forwarding.secret"'));
    assert.ok(out.includes('[query]'));
    assert.ok(out.includes('compression-threshold = 256'));
    assert.ok(out.includes('# What port should the proxy be bound to?'));
  });

  it('is idempotent', () => {
    assert.equal(patchVelocityToml(out, { ...settings, motd: '<green>My "Network"' }), out);
  });

  it('adds sections and keys that are missing', () => {
    const out2 = patchVelocityToml('config-version = "2.8"\n\n[query]\nenabled = false\n', { ...settings, motd: 'x' });
    assert.match(out2, /^bind = /m);
    assert.match(out2, /\[servers\]\n/);
    assert.ok(out2.indexOf('bind =') < out2.indexOf('[query]'), 'top-level keys stay above the first section');
    assert.ok(!out2.includes('[forced-hosts]'));
  });

  it('handles Windows line endings', () => {
    const out3 = patchVelocityToml(REAL.replace(/\n/g, '\r\n'), settings);
    assert.ok(!out3.includes('\r'));
    assert.match(out3, /^lobby = /m);
  });

  it('supports several servers in the try order', () => {
    const out4 = patchVelocityToml(REAL, { ...settings, tryOrder: ['lobby', 'survival'] });
    assert.match(out4, /try = \["lobby", "survival"\]/);
  });
});

describe('ports', () => {
  it('detects used ports', async () => {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    assert.equal(await portFree(port), false);
    await new Promise<void>((r) => srv.close(() => r()));
    assert.equal(await portFree(port), true);
  });

  it('skips taken ports and ports that are in use', async () => {
    const free = (p: number) => Promise.resolve(p !== 30068);
    assert.deepEqual(await allocatePorts(3, [30066], 30066, free), [30067, 30069, 30070]);
    assert.deepEqual(await allocatePorts(0, [], 30066, free), []);
    await assert.rejects(() => allocatePorts(2, [], 65535, free), /No free port/);
  });
});

describe('patchVelocityToml for an imported proxy', () => {
  const existing = [
    '[servers]',
    'hub = "10.0.0.5:25566"',
    '"minigames" = "10.0.0.6:25567" # on another machine',
    'try = ["hub"]',
    '',
    '[forced-hosts]',
    '',
  ].join('\n');
  const mine = { servers: { lobby: '127.0.0.1:30066' }, tryOrder: ['lobby'], keepServers: true };

  it('keeps the servers the proxy already had and adds the network after them', () => {
    const out = patchVelocityToml(existing, mine);
    assert.match(out, /lobby = "127\.0\.0\.1:30066"\n# Servers that were already in this file:\nhub = "10\.0\.0\.5:25566"\n"minigames" = "10\.0\.0\.6:25567" # on another machine\n/);
    assert.match(out, /try = \["lobby", "hub"\]/);
  });

  it('is stable on repeated runs and forgets servers that left the network', () => {
    const once = patchVelocityToml(existing, mine);
    assert.equal(patchVelocityToml(once, mine), once);
    const without = patchVelocityToml(once, { servers: { creative: '127.0.0.1:30070' }, tryOrder: ['creative'], keepServers: true });
    assert.ok(!without.includes('lobby'), 'our removed server is gone');
    assert.ok(without.includes('hub = "10.0.0.5:25566"'), 'the user\'s own server stays');
    assert.match(without, /try = \["creative", "hub"\]/);
  });

  it('does not keep anything unless asked to', () => {
    const out = patchVelocityToml(existing, { servers: { lobby: '127.0.0.1:30066' }, tryOrder: ['lobby'] });
    assert.ok(!out.includes('hub'));
  });
});
