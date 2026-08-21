/**
 * Tests for removing sessions created by the historical observer feedback loop.
 *
 * Mock Justification: NONE (0% mock code)
 * - Uses a real temporary SQLite database and real FTS5 triggers.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

const WORKER_SERVICE_PATH = path.resolve(import.meta.dir, '../../../src/services/worker-service.ts');

const TABLES = [
  'pending_messages',
  'user_prompts',
  'observations',
  'session_summaries',
  'sdk_sessions'
] as const;

describe('SessionStore observer session reaper', () => {
  let dataDir: string;
  let store: SessionStore;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'observer-session-reaper-'));
    const dbPath = path.join(dataDir, 'claude-mem.db');
    store = new SessionStore(dbPath);

    // SessionSearch installs the external-content FTS tables and DELETE triggers.
    const search = new SessionSearch(dbPath);
    search.close();

    seedSession('junk-project', '.claude-mem', 'ordinary prompt', 1000);
    seedSession(
      'junk-prompt',
      'real-project',
      '<observed_from_primary_session>feedback-loop prompt',
      2000
    );
    seedSession('real-session', 'real-project', 'keep this prompt', 3000);

    // Historical queue rows can disagree on their redundant session keys.
    // Rows matching either junk key still belong to the junk session.
    store.db.prepare(`
      INSERT INTO pending_messages (
        session_db_id, content_session_id, message_type, status,
        retry_count, created_at_epoch
      ) VALUES (3, ?, 'observation', ?, 0, ?)
    `).run('junk-project', 'processing', 1001);
    store.db.prepare(`
      INSERT INTO pending_messages (
        session_db_id, content_session_id, message_type, status,
        retry_count, created_at_epoch
      ) VALUES (3, ?, 'observation', ?, 0, ?)
    `).run('junk-prompt', 'processed', 2001);
  });

  afterEach(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function seedSession(
    contentSessionId: string,
    project: string,
    userPrompt: string,
    startedAtEpoch: number
  ): void {
    const sessionDbId = store.createSDKSession(contentSessionId, project, userPrompt);
    const memorySessionId = `memory-${contentSessionId}`;
    const startedAt = new Date(startedAtEpoch).toISOString();
    store.updateMemorySessionId(sessionDbId, memorySessionId);
    store.db.prepare(`
      UPDATE sdk_sessions SET started_at = ?, started_at_epoch = ? WHERE id = ?
    `).run(startedAt, startedAtEpoch, sessionDbId);
    store.saveUserPrompt(contentSessionId, 1, `stored ${userPrompt}`);
    store.storeObservation(memorySessionId, project, {
      type: 'discovery',
      title: `${contentSessionId} searchable observation`,
      subtitle: null,
      facts: [],
      narrative: `${contentSessionId} unique narrative`,
      concepts: [],
      files_read: [],
      files_modified: []
    });
    store.storeSummary(memorySessionId, project, {
      request: contentSessionId,
      investigated: '',
      learned: '',
      completed: '',
      next_steps: '',
      notes: null
    });
    store.db.prepare(`
      INSERT INTO pending_messages (
        session_db_id, content_session_id, message_type, status,
        retry_count, created_at_epoch
      ) VALUES (?, ?, 'observation', ?, 0, ?)
    `).run(
      sessionDbId,
      contentSessionId,
      contentSessionId === 'junk-prompt' ? 'failed' : 'pending',
      startedAtEpoch
    );
  }

  function tableCounts(): Record<string, number> {
    return Object.fromEntries(TABLES.map(table => {
      const row = store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
      return [table, row.count];
    }));
  }

  function runCli(...args: string[]): { exitCode: number; stdout: string } {
    const result = Bun.spawnSync({
      cmd: [process.execPath, WORKER_SERVICE_PATH, 'reap-observer-sessions', ...args],
      env: { ...process.env, CLAUDE_MEM_DATA_DIR: dataDir },
      stdout: 'pipe',
      stderr: 'pipe'
    });
    return { exitCode: result.exitCode, stdout: result.stdout.toString() };
  }

  it('finds junk by project or prompt prefix, most recent first', () => {
    expect(store.findObserverJunkSessions()).toEqual([
      {
        sessionDbId: 2,
        contentSessionId: 'junk-prompt',
        memorySessionId: 'memory-junk-prompt',
        project: 'real-project',
        startedAt: new Date(2000).toISOString(),
        userPrompt: '<observed_from_primary_session>feedback-loop prompt'
      },
      {
        sessionDbId: 1,
        contentSessionId: 'junk-project',
        memorySessionId: 'memory-junk-project',
        project: '.claude-mem',
        startedAt: new Date(1000).toISOString(),
        userPrompt: 'ordinary prompt'
      }
    ]);

    store.db.prepare(`UPDATE sdk_sessions SET project = 'observer-sessions' WHERE id = 1`).run();
    store.db.prepare(`UPDATE sdk_sessions SET user_prompt = 'You are a Claude-Mem observer' WHERE id = 2`).run();
    expect(store.findObserverJunkSessions()).toHaveLength(2);

    store.db.prepare(`UPDATE sdk_sessions SET user_prompt = 'Hello memory agent, observe this' WHERE id = 2`).run();
    expect(store.findObserverJunkSessions()).toHaveLength(2);
  });

  it('counts a dry run without changing any rows', () => {
    const before = tableCounts();
    const result = runCli();

    expect(result.exitCode).toBe(0);
    expect(tableCounts()).toEqual(before);
    expect(result.stdout).toContain('Observer session reap (dry-run)');
    expect(result.stdout).toContain('Pending messages:  4');
    expect(result.stdout).toContain('junk-prompt | real-project | 1970-01-01T00:00:02.000Z');
    expect(result.stdout).toContain('Chroma documents are not deleted');
  });

  it('deletes only junk rows and removes their external-content FTS entries', () => {
    const result = runCli('--apply');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Observer session reap (applied)');

    expect(tableCounts()).toEqual({
      pending_messages: 1,
      user_prompts: 1,
      observations: 1,
      session_summaries: 1,
      sdk_sessions: 1
    });
    expect(store.db.prepare('SELECT content_session_id FROM sdk_sessions').all()).toEqual([
      { content_session_id: 'real-session' }
    ]);
    expect(store.db.prepare(`
      SELECT rowid FROM observations_fts WHERE observations_fts MATCH ?
    `).all('"junk-prompt"')).toEqual([]);
    expect(store.db.prepare(`
      SELECT rowid FROM observations_fts WHERE observations_fts MATCH ?
    `).all('"real-session"')).toHaveLength(1);
  });
});
