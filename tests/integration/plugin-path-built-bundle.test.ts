/**
 * Integration tests against the BUILT worker bundle (plugin/scripts/worker-service.cjs):
 * - CLAUDE_CODE_PATH=@plugin/<file> resolves to the running bundle's directory.
 * - A daemon started from an outdated plugin cache dir hands off to the bundle
 *   that installed_plugins.json names.
 *
 * Each worker runs with a temporary HOME, its own free port and a stub `ps`
 * first on PATH. The stub matters: worker startup SIGKILLs every process whose
 * command line contains "worker-service.cjs" (aggressiveStartupCleanup), which
 * would otherwise take down the live worker on this machine.
 */
import { describe, it, expect, afterAll } from 'bun:test';
import { spawn } from 'child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import path from 'path';

const WORKER_SCRIPT = path.join(__dirname, '../../plugin/scripts/worker-service.cjs');
const homes: string[] = [];
const pids: number[] = [];

afterAll(() => {
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor<T>(probe: () => T | undefined | Promise<T | undefined>, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch {
      // not ready yet
    }
    await new Promise(r => setTimeout(r, 250));
  }
  return undefined;
}

function readLogs(logsDir: string): string {
  if (!existsSync(logsDir)) return '';
  return readdirSync(logsDir)
    .filter(f => f.startsWith('claude-mem-') && f.endsWith('.log'))
    .map(f => readFileSync(path.join(logsDir, f), 'utf-8'))
    .join('\n');
}

/** Temp HOME with settings, a stub ps and a free port; starts `script --daemon`. */
async function startIsolatedWorker(settings: Record<string, string>, prepare?: (home: string) => string) {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'cm-built-bundle-')));
  homes.push(home);
  const dataDir = path.join(home, '.claude-mem');
  const stubBin = path.join(home, 'bin');
  mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  mkdirSync(stubBin, { recursive: true });
  writeFileSync(path.join(stubBin, 'ps'), '#!/bin/sh\necho "  PID COMMAND"\n');
  chmodSync(path.join(stubBin, 'ps'), 0o755);

  const port = await freePort();
  writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
    CLAUDE_MEM_WORKER_PORT: String(port),
    CLAUDE_MEM_CHROMA_ENABLED: 'false',
    CLAUDE_MEM_TRANSCRIPTS_ENABLED: 'false',
    ...settings,
  }, null, 2));

  const script = prepare ? prepare(home) : WORKER_SCRIPT;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('CLAUDE_MEM_') && !k.startsWith('CLAUDE_CODE') && k !== 'CLAUDE_CONFIG_DIR') env[k] = v;
  }
  Object.assign(env, { HOME: home, PATH: `${stubBin}:${process.env.PATH}`, OMLX_SHIM_NOTIFY: '0' });

  const child = spawn(process.execPath, [script, '--daemon'], { env, stdio: 'ignore' });
  if (child.pid) pids.push(child.pid);

  const base = `http://127.0.0.1:${port}`;
  const health = await waitFor(async () => {
    const res = await fetch(`${base}/api/health`);
    return res.ok ? (await res.json()) as { workerPath: string; pid: number } : undefined;
  }, 30000);
  if (health) pids.push(health.pid);
  return { home, base, health, logsDir: path.join(dataDir, 'logs') };
}

describe('built worker bundle', () => {
  it('spawns the in-tree shim via CLAUDE_CODE_PATH=@plugin/omlx-claude-shim.py', async () => {
    expect(existsSync(WORKER_SCRIPT)).toBe(true);
    expect(existsSync(path.join(path.dirname(WORKER_SCRIPT), 'omlx-claude-shim.py'))).toBe(true);

    const { home, base, health, logsDir } = await startIsolatedWorker({
      CLAUDE_CODE_PATH: '@plugin/omlx-claude-shim.py',
      CLAUDE_MEM_PROVIDER: 'claude',
      CLAUDE_MEM_OMLX_ENDPOINTS: 'http://127.0.0.1:9/v1',
    });
    expect(health).toBeDefined();

    const contentSessionId = `plugin-path-${Date.now()}`;
    const post = (route: string, body: object) => fetch(`${base}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect((await post('/api/sessions/init', {
      contentSessionId, project: 'plugin-path-test', prompt: 'integration test prompt',
    })).ok).toBe(true);
    expect((await post('/api/sessions/observations', {
      contentSessionId, tool_name: 'Bash', tool_input: { command: 'ls' },
      tool_response: { stdout: 'a\nb' }, cwd: home,
    })).ok).toBe(true);

    const shimLog = path.join(logsDir, 'omlx-shim.log');
    const started = await waitFor(
      () => existsSync(shimLog) && /start session=/.test(readFileSync(shimLog, 'utf-8')),
      30000,
    );
    expect(readLogs(logsDir)).not.toContain('does not exist');
    expect(started).toBe(true);
  }, 90000);

  it('hands off from an outdated cache dir to the installed bundle', async () => {
    let installedScript = '';
    const { health, logsDir } = await startIsolatedWorker({}, home => {
      const pluginDir = path.join(home, '.claude', 'plugins', 'cache', 'irion94', 'claude-mem');
      const scriptFor = (version: string) => {
        const dir = path.join(pluginDir, version);
        mkdirSync(path.join(dir, 'scripts'), { recursive: true });
        mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
        writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ version }));
        copyFileSync(WORKER_SCRIPT, path.join(dir, 'scripts', 'worker-service.cjs'));
        return path.join(dir, 'scripts', 'worker-service.cjs');
      };
      const oldScript = scriptFor('12.3.9-baton.2');
      installedScript = scriptFor('12.3.9-baton.5');
      writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
        version: 2,
        plugins: { 'claude-mem@irion94': [{ scope: 'user', installPath: path.dirname(path.dirname(installedScript)), version: '12.3.9-baton.5' }] },
      }));
      return oldScript;
    });

    expect(health?.workerPath).toBe(installedScript);
    const logs = readLogs(logsDir);
    expect(logs).toContain('Worker boot 12.3.9-baton.2');
    expect(logs).toContain('Worker handoff 12.3.9-baton.2 -> 12.3.9-baton.5');
    expect(logs).toContain('Worker boot 12.3.9-baton.5');
    expect(logs.match(/Worker handoff/g)?.length).toBe(1);
  }, 90000);
});
