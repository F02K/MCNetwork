// Builds the Paper and Velocity plugins (agent/, needs a JDK 17+ and Maven), runs their tests and
// copies the jars to agent/jars/ together with a manifest (version and sha256). The daemon installs
// exactly these files, so the committed jars and manifest must match the sources: run this after changing agent/.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const agent = 'agent';
const out = join(agent, 'jars');
const pom = readFileSync(join(agent, 'pom.xml'), 'utf8');
const version = /<artifactId>mcnetwork-agent-parent<\/artifactId>\s*<version>([^<]+)<\/version>/.exec(pom)?.[1];
if (!version) throw new Error('Cannot read the agent version from agent/pom.xml');

const mvn = spawnSync('mvn', ['-q', '-B', '-f', join(agent, 'pom.xml'), 'clean', 'package'], { stdio: 'inherit' });
if (mvn.status !== 0) process.exit(mvn.status ?? 1);

mkdirSync(out, { recursive: true });
const jars = {};
for (const kind of ['paper', 'velocity']) {
  const file = `mcnetwork-agent-${kind}.jar`;
  copyFileSync(join(agent, kind, 'target', file), join(out, file));
  const bytes = readFileSync(join(out, file));
  jars[kind] = { file, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
writeFileSync(join(out, 'manifest.json'), JSON.stringify({ version, jars }, null, 2) + '\n');
console.log(`Agent ${version}: ${Object.values(jars).map((j) => `${j.file} (${j.size} bytes)`).join(', ')}`);
