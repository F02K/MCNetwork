import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { validateServer, WINDOWS_RESERVED_RE } from '../src/config';
import { parseSetupRequest } from '../src/setup/provision';
import { backendHost, proxyBind, setProxyPort } from '../src/setup/layout';
import { tmp } from './helpers';
import { writeFileSync } from 'node:fs';

interface Answers {
  inside: boolean[];
  dirs: string[];
  absolute: boolean[];
  external: string[];
  internal: [string, string];
  config: string[];
}

describe('Windows paths', () => {
  it('are handled with drive letters and backslashes (path module switched to win32)', () => {
    const out = execFileSync(process.execPath, ['--require', join(__dirname, 'win32-preload.js'), join(__dirname, 'win32-child.js')], { encoding: 'utf8' });
    const a = JSON.parse(out) as Answers;
    assert.deepEqual(a.inside, [true, true, false, false, false, false]);
    assert.deepEqual(a.dirs, ['C:\\MCNetwork\\data\\servers\\lobby', 'D:\\Minecraft\\survival']);
    assert.deepEqual(a.absolute, [true, true, false, true]); // a path starting with a slash is rooted on the current drive
    assert.equal(a.external[0], 'ok');
    assert.match(a.external[1], /absolute folder/);
    assert.match(a.external[2], /without "\.\."/);
    assert.equal(a.internal[0], 'servers\\lobby');
    assert.match(a.internal[1], /relative folder inside the data directory/);
    assert.deepEqual(a.config, ['C:\\mcli\\mcli.js', 'C:\\MCNetwork\\data\\mcli.js']);
  });
});

describe('Windows specifics', () => {
  it('refuses the names Windows reserves for devices', () => {
    for (const id of ['con', 'prn', 'aux', 'nul', 'com1', 'com9', 'lpt1']) {
      assert.match(WINDOWS_RESERVED_RE.source, /con/);
      assert.throws(() => validateServer({ id }, tmp()), /reserved name on Windows/, id);
      assert.throws(() => parseSetupRequest({ acceptEula: true, backends: [{ id }] }, []), /reserved name on Windows/, id);
    }
    assert.equal(validateServer({ id: 'console' }, tmp()).id, 'console', 'only the exact names are reserved');
    assert.equal(validateServer({ id: 'com10' }, tmp()).id, 'com10');
  });

  it('reads and changes files that were written with Windows line endings', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'server.properties'), '#Minecraft server properties\r\nserver-port=25565\r\nserver-ip=127.0.0.1\r\nonline-mode=true\r\n');
    assert.equal(backendHost(dir), '127.0.0.1');
    writeFileSync(join(dir, 'velocity.toml'), 'motd = "x"\r\nbind = "0.0.0.0:25565"\r\n\r\n[query]\r\nenabled = false\r\nport = 25565\r\n');
    assert.deepEqual(proxyBind(dir), { host: '0.0.0.0', port: 25565 });
    const moved = setProxyPort('motd = "x"\r\nbind = "0.0.0.0:25565"\r\n\r\n[query]\r\nenabled = false\r\nport = 25565\r\n', 25565, 25570);
    assert.match(moved, /bind = "0\.0\.0\.0:25570"/);
    assert.match(moved, /\[query\][\s\S]*port = 25570/);
  });
});
