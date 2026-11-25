import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { findApp, resolveConfigured } from '../src/appdir';
import { defaultConfig, resolveMcliPath } from '../src/config';
import { tmp } from './helpers';

describe('program folder lookup', () => {
  it('uses a configured absolute path as it is', () => {
    const abs = join(tmp(), 'mcli.js');
    assert.equal(resolveConfigured(tmp(), abs, []), abs);
  });

  it('looks in the data folder first, then in the program folders, then falls back to the data folder', () => {
    const data = tmp();
    const app = tmp();
    assert.equal(resolveConfigured(data, 'mcli.js', [app]), join(data, 'mcli.js'), 'nothing exists: the data folder is where it is expected');
    writeFileSync(join(app, 'mcli.js'), 'x');
    assert.equal(resolveConfigured(data, 'mcli.js', [app]), join(app, 'mcli.js'), 'found next to the program');
    writeFileSync(join(data, 'mcli.js'), 'x');
    assert.equal(resolveConfigured(data, 'mcli.js', [app]), join(data, 'mcli.js'), 'the data folder wins');
  });

  it('finds the MCLI file for the configuration', () => {
    const data = tmp();
    const cfg = { ...defaultConfig(), mcliPath: 'tools/mcli.js' };
    mkdirSync(join(data, 'tools'));
    writeFileSync(join(data, 'tools', 'mcli.js'), 'x');
    assert.equal(resolveMcliPath(data, cfg, []), join(data, 'tools', 'mcli.js'));
  });

  it('finds nothing for files that are not there', () => {
    assert.equal(findApp('definitely', 'not', 'here'), null);
  });
});
