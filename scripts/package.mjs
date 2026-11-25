// Assembles a ready-to-run folder (release/mcnetwork) that can simply be zipped and copied to a server:
//   node scripts/package.mjs [--mcli path/to/mcli.js]
// It contains the bundle, the dashboard, the agent plugin jars, the docs and start scripts for Windows and Linux.
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = join('release', 'mcnetwork');
const mcliArg = process.argv.indexOf('--mcli') >= 0 ? process.argv[process.argv.indexOf('--mcli') + 1] : process.env.MCLI_BUNDLE;

const build = spawnSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);
if (!existsSync(join('agent', 'jars', 'manifest.json'))) {
  console.error('agent/jars is missing: run "npm run build:agent" first.');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
copyFileSync(join('dist', 'mcnetwork.js'), join(out, 'mcnetwork.js'));
cpSync('web', join(out, 'web'), { recursive: true });
cpSync(join('agent', 'jars'), join(out, 'agent', 'jars'), { recursive: true });
cpSync('docs', join(out, 'docs'), { recursive: true });
copyFileSync('README.md', join(out, 'README.md'));
for (const f of ['start.bat', 'start.sh']) copyFileSync(join('scripts', 'launch', f), join(out, f));
if (mcliArg) {
  if (!existsSync(mcliArg)) throw new Error(`mcli.js not found: ${mcliArg}`);
  copyFileSync(mcliArg, join(out, 'mcli.js'));
}
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
writeFileSync(join(out, 'VERSION'), `${version}\n`);
console.log(`Packaged MCNetwork ${version} in ${out}${mcliArg ? ' (with mcli.js)' : ' (put mcli.js next to mcnetwork.js)'}. Zip that folder and copy it to the server.`);
