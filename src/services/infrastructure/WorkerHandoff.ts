/**
 * Worker version handoff.
 *
 * Hooks spawn the worker from the plugin root their Claude Code session was
 * started with. A session that predates a plugin update therefore resurrects
 * an old bundle whenever the worker is down. Before binding, a daemon checks
 * installed_plugins.json and, when the installed version lives in another
 * cache dir, spawns that bundle instead.
 */
import { existsSync, readFileSync, realpathSync } from 'fs';
import { basename, dirname, join } from 'path';

/** Set on the handed-off daemon so it never hands off again. */
export const HANDOFF_ENV = 'CLAUDE_MEM_WORKER_HANDOFF_FROM';

/** Version from <pluginRoot>/.claude-plugin/plugin.json, or 'unknown'. */
export function readBundleVersion(pluginRoot: string): string {
  try {
    const manifest = JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf-8'));
    return typeof manifest.version === 'string' ? manifest.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Worker script of the installed plugin version when it is complete and lives
 * outside the running bundle's plugin root; otherwise null. The plugin key
 * comes from the cache layout <cache>/<marketplace>/<plugin>/<version>/scripts/.
 */
export function chooseInstalledWorkerScript(ownScript: string, installedPluginsPath: string): string | null {
  const ownRoot = dirname(dirname(ownScript));
  const pluginDir = dirname(ownRoot);
  const key = `${basename(pluginDir)}@${basename(dirname(pluginDir))}`;

  let entries: Array<{ scope?: string; installPath?: string }>;
  try {
    entries = JSON.parse(readFileSync(installedPluginsPath, 'utf-8')).plugins?.[key] ?? [];
  } catch {
    return null;
  }
  if (!Array.isArray(entries)) return null;

  const installPath = (entries.find(e => e.scope === 'user') ?? entries[0])?.installPath;
  if (!installPath) return null;

  const script = join(installPath, 'scripts', 'worker-service.cjs');
  if (!existsSync(script) || !existsSync(ownRoot)) return null;
  if (realpathSync(installPath) === realpathSync(ownRoot)) return null;
  return script;
}
