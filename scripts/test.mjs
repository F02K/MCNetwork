// Compiles src/ and test/ with esbuild (one JS file per TS file, inline source maps) and runs
// the node:test suite. With --coverage the run is wrapped in c8 so coverage maps back to the TS sources.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const OUT = '.test-build';

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

rmSync(OUT, { recursive: true, force: true });
await build({
  entryPoints: [...walk('src'), ...walk('test')],
  outdir: OUT,
  outbase: '.',
  bundle: false,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  sourcemap: 'inline',
  logLevel: 'warning',
});

const coverage = process.argv.includes('--coverage');
const files = walk('test').filter((f) => f.endsWith('.test.ts')).map((f) => join(OUT, f.replace(/\.ts$/, '.js')));
const nodeArgs = ['--test', '--test-reporter=spec', ...files];
const cmd = coverage ? [join('node_modules', 'c8', 'bin', 'c8.js'), process.execPath, ...nodeArgs] : nodeArgs;
const res = spawnSync(process.execPath, cmd, { stdio: 'inherit' });
process.exit(res.status ?? 1);
