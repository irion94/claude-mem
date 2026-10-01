/**
 * resolvePluginRelativePath: settings values like CLAUDE_CODE_PATH may point
 * at a file shipped next to the worker bundle with an `@plugin/` prefix, so
 * the setting survives plugin cache version bumps.
 */

import { describe, it, expect } from 'bun:test';
import { join } from 'path';
import { resolvePluginRelativePath, runningBundleDir } from '../../src/shared/paths.js';

describe('resolvePluginRelativePath', () => {
  const scriptsDir = '/cache/irion94/claude-mem/12.3.9-baton.4/scripts';

  it('resolves an @plugin/ value against the given scripts dir', () => {
    expect(resolvePluginRelativePath('@plugin/omlx-claude-shim.py', scriptsDir))
      .toBe(join(scriptsDir, 'omlx-claude-shim.py'));
  });

  it('defaults the base to the directory of the running bundle', () => {
    const resolved = resolvePluginRelativePath('@plugin/omlx-claude-shim.py');
    expect(resolved.startsWith('@plugin/')).toBe(false);
    expect(resolved.endsWith('/omlx-claude-shim.py')).toBe(true);
  });

  it('returns any other value unchanged', () => {
    expect(resolvePluginRelativePath('/usr/local/bin/claude', scriptsDir)).toBe('/usr/local/bin/claude');
    expect(resolvePluginRelativePath('claude', scriptsDir)).toBe('claude');
    expect(resolvePluginRelativePath('plugin/x.py', scriptsDir)).toBe('plugin/x.py');
  });
});

describe('runningBundleDir', () => {
  const scripts = '/cache/irion94/claude-mem/12.3.9-baton.5/scripts';

  it('prefers the native CJS __dirname', () => {
    expect(runningBundleDir(scripts, '/elsewhere/worker-service.cjs')).toBe(scripts);
  });

  it('falls back to the directory of argv[1] when it is worker-service.cjs', () => {
    expect(runningBundleDir(null, `${scripts}/worker-service.cjs`)).toBe(scripts);
  });

  it('refuses any other entry instead of guessing', () => {
    expect(() => runningBundleDir(null, '/usr/bin/some-cli.js')).toThrow('Cannot locate');
    expect(() => runningBundleDir(null, '')).toThrow('Cannot locate');
  });
});
