import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

const WEB = join(process.cwd(), 'web', 'js');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : n.endsWith('.js') && n !== 'lang-de.js' ? [join(dir, n)] : []));
}

/** Every text the dashboard passes to t('...'). */
function usedTexts(): Set<string> {
  const out = new Set<string>();
  for (const f of files(WEB)) {
    for (const m of readFileSync(f, 'utf8').matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)) out.add(m[1].replace(/\\'/g, "'"));
  }
  return out;
}

describe('dashboard translations', () => {
  it('has a German text for every English text, and none that is unused', async () => {
    const { DE } = (await import(pathToFileURL(join(WEB, 'lang-de.js')).href)) as { DE: Record<string, string> };
    const used = usedTexts();
    assert.ok(used.size > 150, 'the scan found the texts');
    assert.deepEqual([...used].filter((t) => !(t in DE)), [], 'texts without a German translation');
    assert.deepEqual(Object.keys(DE).filter((k) => !used.has(k)), [], 'translations for texts that no longer exist');
  });

  it('keeps placeholders such as {name} in the translation', async () => {
    const { DE } = (await import(pathToFileURL(join(WEB, 'lang-de.js')).href)) as { DE: Record<string, string> };
    for (const [en, de] of Object.entries(DE)) {
      const vars = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(',');
      assert.equal(vars(de), vars(en), `placeholders differ in: ${en}`);
    }
  });
});
