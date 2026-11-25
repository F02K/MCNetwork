import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { agentConfigText, agentKind, AGENT_JAR, installAgent, loadManifest } from '../src/agent/install';
import { makeAgentJars, tmp } from './helpers';

const settings = { url: 'http://127.0.0.1:8080', token: 'tok', serverId: 'lobby' };

describe('agent installation', () => {
  it('maps roles to plugins', () => {
    assert.equal(agentKind('proxy'), 'velocity');
    assert.equal(agentKind('backend'), 'paper');
  });

  it('reads the manifest, or says nothing when the plugins were not built', () => {
    assert.equal(loadManifest(makeAgentJars('1.2.3'))?.version, '1.2.3');
    assert.equal(loadManifest(tmp()), null);
    const broken = tmp();
    writeFileSync(join(broken, 'manifest.json'), '{"version":"1"}');
    assert.equal(loadManifest(broken), null);
    writeFileSync(join(broken, 'manifest.json'), 'nope');
    assert.equal(loadManifest(broken), null);
  });

  it('writes the config text MCNetwork owns', () => {
    assert.equal(agentConfigText({ ...settings, intervalSeconds: 15 }), '# Written by MCNetwork. Changes are overwritten.\nurl=http://127.0.0.1:8080\ntoken=tok\nserver-id=lobby\ninterval-seconds=15\n');
    assert.match(agentConfigText(settings), /interval-seconds=10/);
  });

  it('installs the Paper plugin and its configuration', () => {
    const jars = makeAgentJars();
    const dir = tmp();
    const r = installAgent(dir, 'backend', jars, settings);
    assert.deepEqual(r, { kind: 'paper', version: '0.1.0', jar: 'installed', config: 'written' });
    assert.equal(readFileSync(join(dir, 'plugins', AGENT_JAR), 'utf8'), 'fake paper jar 0.1.0');
    assert.equal(readFileSync(join(dir, 'plugins', 'MCNetworkAgent', 'config.properties'), 'utf8'), agentConfigText(settings));
  });

  it('installs the Velocity plugin into the folder Velocity uses for its config', () => {
    const dir = tmp();
    const r = installAgent(dir, 'proxy', makeAgentJars(), { ...settings, serverId: 'proxy' });
    assert.equal(r.kind, 'velocity');
    assert.equal(readFileSync(join(dir, 'plugins', AGENT_JAR), 'utf8'), 'fake velocity jar 0.1.0');
    assert.match(readFileSync(join(dir, 'plugins', 'mcnetwork-agent', 'config.properties'), 'utf8'), /server-id=proxy/);
  });

  it('does nothing when everything is current, and repairs a changed jar or config', () => {
    const jars = makeAgentJars();
    const dir = tmp();
    installAgent(dir, 'backend', jars, settings);
    assert.deepEqual(installAgent(dir, 'backend', jars, settings), { kind: 'paper', version: '0.1.0', jar: 'current', config: 'current' });
    writeFileSync(join(dir, 'plugins', AGENT_JAR), 'old');
    assert.equal(installAgent(dir, 'backend', jars, settings).jar, 'updated');
    assert.equal(readFileSync(join(dir, 'plugins', AGENT_JAR), 'utf8'), 'fake paper jar 0.1.0');
    assert.equal(installAgent(dir, 'backend', jars, { ...settings, token: 'new' }).config, 'written');
    assert.match(readFileSync(join(dir, 'plugins', 'MCNetworkAgent', 'config.properties'), 'utf8'), /token=new/);
  });

  it('refuses missing plugins and jars that do not match the manifest', () => {
    assert.throws(() => installAgent(tmp(), 'backend', tmp(), settings), /npm run build:agent/);
    const jars = makeAgentJars();
    writeFileSync(join(jars, 'mcnetwork-agent-paper.jar'), 'tampered');
    const dir = tmp();
    assert.throws(() => installAgent(dir, 'backend', jars, settings), /does not match the manifest/);
    assert.equal(existsSync(join(dir, 'plugins', AGENT_JAR)), false, 'a bad jar is never installed');
  });
});
