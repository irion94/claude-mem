/**
 * chooseInstalledWorkerScript: a daemon spawned from an old plugin cache dir
 * must find the installed version's worker bundle via installed_plugins.json.
 * Fixture dirs only; the real ~/.claude is never read.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { chooseInstalledWorkerScript, readBundleVersion } from '../../src/services/infrastructure/WorkerHandoff.js';

let root: string;
let cache: string;
let installed: string;

function bundle(version: string, withScript = true): string {
  const dir = path.join(cache, 'irion94', 'claude-mem', version);
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ version }));
  if (withScript) writeFileSync(path.join(dir, 'scripts', 'worker-service.cjs'), '');
  return dir;
}

function install(entries: object): void {
  writeFileSync(installed, JSON.stringify({ version: 2, plugins: { 'claude-mem@irion94': entries } }));
}

const script = (dir: string) => path.join(dir, 'scripts', 'worker-service.cjs');

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'cm-handoff-'));
  cache = path.join(root, 'plugins', 'cache');
  installed = path.join(root, 'plugins', 'installed_plugins.json');
  mkdirSync(path.dirname(installed), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('chooseInstalledWorkerScript', () => {
  it('returns the installed bundle when it differs from the running one', () => {
    const old = bundle('12.3.9-baton.2');
    const current = bundle('12.3.9-baton.5');
    install([{ scope: 'user', installPath: current, version: '12.3.9-baton.5' }]);
    expect(chooseInstalledWorkerScript(script(old), installed)).toBe(script(current));
  });

  it('returns null when the running bundle is the installed one', () => {
    const current = bundle('12.3.9-baton.5');
    install([{ scope: 'user', installPath: current }]);
    expect(chooseInstalledWorkerScript(script(current), installed)).toBeNull();
  });

  it('returns null when the installed dir has no worker-service.cjs', () => {
    const old = bundle('12.3.9-baton.2');
    const partial = bundle('12.3.9-baton.5', false);
    install([{ scope: 'user', installPath: partial }]);
    expect(chooseInstalledWorkerScript(script(old), installed)).toBeNull();
  });

  it('prefers the user-scope entry over a project-scope one', () => {
    const old = bundle('12.3.9-baton.2');
    const project = bundle('12.3.9-baton.3');
    const user = bundle('12.3.9-baton.5');
    install([
      { scope: 'project', installPath: project },
      { scope: 'user', installPath: user },
    ]);
    expect(chooseInstalledWorkerScript(script(old), installed)).toBe(script(user));
  });

  it('returns null without a usable installed_plugins.json entry', () => {
    const old = bundle('12.3.9-baton.2');
    expect(chooseInstalledWorkerScript(script(old), installed)).toBeNull();
    writeFileSync(installed, '{not json');
    expect(chooseInstalledWorkerScript(script(old), installed)).toBeNull();
    writeFileSync(installed, JSON.stringify({ version: 2, plugins: { 'other@irion94': [] } }));
    expect(chooseInstalledWorkerScript(script(old), installed)).toBeNull();
  });

  it('returns null when running outside the plugin cache layout', () => {
    const current = bundle('12.3.9-baton.5');
    install([{ scope: 'user', installPath: current }]);
    expect(chooseInstalledWorkerScript('/repo/plugin/scripts/worker-service.cjs', installed)).toBeNull();
  });
});

describe('readBundleVersion', () => {
  it('reads the manifest version, unknown when missing', () => {
    expect(readBundleVersion(bundle('12.3.9-baton.5'))).toBe('12.3.9-baton.5');
    expect(readBundleVersion(path.join(root, 'nope'))).toBe('unknown');
  });
});
