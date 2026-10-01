/**
 * Integration test against the BUILT worker bundle: CLAUDE_CODE_PATH=@plugin/<file>
 * must resolve to the directory of the running plugin/scripts/worker-service.cjs.
 *
 * The worker runs with a temporary HOME, its own free port and a stub `ps` first
 * on PATH. The stub matters: worker startup SIGKILLs every process whose command
 * line contains "worker-service.cjs" (aggressiveStartupCleanup), which would
 * otherwise take down the live worker on this machine.
 */
import { describe, it, expect, afterAll } from 'bun:test';
import { spawn, type ChildProcess } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import path from 'path';

const WORKER_SCRIPT = path.join(__dirname, '../../plugin/scripts/worker-service.cjs');

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

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return true;
    } catch {
      // not ready yet
    }
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

function readLogs(logsDir: string): string {
  if (!existsSync(logsDir)) return '';
  return readdirSync(logsDir)
    .filter(f => f.startsWith('claude-mem-') && f.endsWith('.log'))
    .map(f => readFileSync(path.join(logsDir, f), 'utf-8'))
    .join('\n');
}

describe('built worker bundle resolves @plugin paths', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'cm-plugin-path-'));
  const dataDir = path.join(home, '.claude-mem');
  const logsDir = path.join(dataDir, 'logs');
  const stubBin = path.join(home, 'bin');
  let worker: ChildProcess | undefined;

  afterAll(() => {
    if (worker && worker.exitCode === null) worker.kill('SIGKILL');
    rmSync(home, { recursive: true, force: true });
  });

  it('spawns the in-tree shim via CLAUDE_CODE_PATH=@plugin/omlx-claude-shim.py', async () => {
    expect(existsSync(WORKER_SCRIPT)).toBe(true);
    expect(existsSync(path.join(path.dirname(WORKER_SCRIPT), 'omlx-claude-shim.py'))).toBe(true);

    const port = await freePort();
    mkdirSync(logsDir, { recursive: true });
    mkdirSync(stubBin, { recursive: true });
    writeFileSync(path.join(stubBin, 'ps'), '#!/bin/sh\necho "  PID COMMAND"\n');
    chmodSync(path.join(stubBin, 'ps'), 0o755);
    writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
      CLAUDE_CODE_PATH: '@plugin/omlx-claude-shim.py',
      CLAUDE_MEM_WORKER_PORT: String(port),
      CLAUDE_MEM_PROVIDER: 'claude',
      CLAUDE_MEM_CHROMA_ENABLED: 'false',
      CLAUDE_MEM_TRANSCRIPTS_ENABLED: 'false',
      CLAUDE_MEM_OMLX_ENDPOINTS: 'http://127.0.0.1:9/v1',
    }, null, 2));

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !k.startsWith('CLAUDE_MEM_') && !k.startsWith('CLAUDE_CODE')) env[k] = v;
    }
    Object.assign(env, { HOME: home, PATH: `${stubBin}:${process.env.PATH}`, OMLX_SHIM_NOTIFY: '0' });

    worker = spawn(process.execPath, [WORKER_SCRIPT, '--daemon'], { env, stdio: 'ignore' });
    const base = `http://127.0.0.1:${port}`;
    const healthy = await waitFor(async () => (await fetch(`${base}/api/health`)).ok, 30000);
    expect(healthy).toBe(true);

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
    const logs = readLogs(logsDir);
    expect(logs).not.toContain('does not exist');
    expect(started).toBe(true);
  }, 90000);
});
