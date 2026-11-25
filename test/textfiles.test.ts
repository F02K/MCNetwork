import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { patchProperties, patchYamlBlock, updateFile, yamlScalar } from '../src/setup/textfiles';
import { tmp } from './helpers';

describe('patchProperties', () => {
  it('changes existing keys in place and keeps comments and unknown keys', () => {
    const out = patchProperties('#Minecraft server properties\nmotd=Hello\nserver-port=25565\nonline-mode=true\nfoo=bar\n', { 'server-port': 30066, 'online-mode': false });
    assert.equal(out, '#Minecraft server properties\nmotd=Hello\nserver-port=30066\nonline-mode=false\nfoo=bar\n');
  });

  it('adds missing keys at the end and works on an empty file', () => {
    assert.equal(patchProperties('', { 'server-ip': '127.0.0.1' }), 'server-ip=127.0.0.1\n');
    assert.equal(patchProperties('a=1\n\n\n', { b: 2 }), 'a=1\nb=2\n');
    assert.equal(patchProperties('a = 1\r\n', { a: 5 }), 'a=5\n');
  });
});

// shaped like the file Paper writes on its first start
const PAPER = `# This is the global configuration file for Paper.
# Configuration documentation: https://docs.papermc.io

_version: 29

chunk-loading:
  autoconfig-send-distance: true
proxies:
  bungee-cord:
    online-mode: true
  # Enable this when running behind a proxy-protocol proxy
  proxy-protocol: false
  velocity:
    enabled: false
    online-mode: true
    secret: ''
timings:
  enabled: true
`;

describe('patchYamlBlock', () => {
  it('sets values inside an existing nested block and leaves the rest alone', () => {
    const out = patchYamlBlock(PAPER, ['proxies', 'velocity'], { enabled: true, 'online-mode': true, secret: 'abc' });
    assert.ok(out.includes("  velocity:\n    enabled: true\n    online-mode: true\n    secret: 'abc'\n"));
    assert.ok(out.includes('  # Enable this when running behind a proxy-protocol proxy\n  proxy-protocol: false'));
    assert.ok(out.includes('timings:\n  enabled: true\n'), 'the next top-level section is untouched');
    assert.ok(out.includes('_version: 29'));
    assert.equal(out.split("secret:").length, 2);
  });

  it('creates the block when it is missing, at any depth', () => {
    const out = patchYamlBlock('_version: 29\nproxies:\n  proxy-protocol: false\n', ['proxies', 'velocity'], { enabled: true, secret: "it's" });
    assert.equal(out, "_version: 29\nproxies:\n  proxy-protocol: false\n  velocity:\n    enabled: true\n    secret: 'it''s'\n");
    assert.equal(patchYamlBlock('', ['proxies', 'velocity'], { enabled: true }), 'proxies:\n  velocity:\n    enabled: true\n');
    assert.equal(patchYamlBlock('other: 1\n', ['proxies', 'velocity'], { enabled: true }), 'other: 1\nproxies:\n  velocity:\n    enabled: true\n');
  });

  it('adds a missing key to an existing block and is idempotent', () => {
    const once = patchYamlBlock('proxies:\n  velocity:\n    enabled: false\n', ['proxies', 'velocity'], { enabled: true, secret: 'x' });
    assert.equal(once, "proxies:\n  velocity:\n    enabled: true\n    secret: 'x'\n");
    assert.equal(patchYamlBlock(once, ['proxies', 'velocity'], { enabled: true, secret: 'x' }), once);
  });

  it('does not touch a same-named key in another block', () => {
    const text = 'a:\n  velocity:\n    enabled: false\nproxies:\n  velocity:\n    enabled: false\n';
    assert.equal(patchYamlBlock(text, ['proxies', 'velocity'], { enabled: true }), 'a:\n  velocity:\n    enabled: false\nproxies:\n  velocity:\n    enabled: true\n');
  });

  it('quotes strings and not booleans or numbers', () => {
    assert.equal(yamlScalar('a'), "'a'");
    assert.equal(yamlScalar(true), 'true');
    assert.equal(yamlScalar(5), '5');
  });
});

describe('updateFile', () => {
  it('patches a file or creates it', () => {
    const dir = tmp();
    const file = join(dir, 'server.properties');
    updateFile(file, (t) => patchProperties(t, { a: 1 }));
    assert.equal(readFileSync(file, 'utf8'), 'a=1\n');
    writeFileSync(file, 'a=1\nb=2\n');
    updateFile(file, (t) => patchProperties(t, { a: 9 }));
    assert.equal(readFileSync(file, 'utf8'), 'a=9\nb=2\n');
  });
});
