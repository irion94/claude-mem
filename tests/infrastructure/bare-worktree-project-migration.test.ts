import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { runOneTimeBareWorktreeProjectMigration } from '../../src/services/infrastructure/ProcessManager.js';

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com'
    }
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

describe('bare worktree project migration', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('prefixes resolvable bare worktree keys once and leaves unresolved rows alone', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bare-worktree-migration-'));
    tempDirs.push(root);
    const repo = path.join(root, 'fixture-repo');
    const worktree = path.join(root, 'feat+resolved');
    const dataDir = path.join(root, 'data');
    mkdirSync(repo);
    mkdirSync(dataDir);
    git(repo, ['init']);
    git(repo, ['commit', '--allow-empty', '-m', 'initial']);
    git(repo, ['worktree', 'add', '-b', 'feat/resolved', worktree]);

    const db = new Database(path.join(dataDir, 'claude-mem.db'));
    db.run(`
      CREATE TABLE sdk_sessions (
        id INTEGER PRIMARY KEY,
        content_session_id TEXT NOT NULL,
        memory_session_id TEXT,
        project TEXT NOT NULL
      );
      CREATE TABLE pending_messages (
        id INTEGER PRIMARY KEY,
        content_session_id TEXT NOT NULL,
        cwd TEXT
      );
      CREATE TABLE observations (id INTEGER PRIMARY KEY, memory_session_id TEXT, project TEXT NOT NULL);
      CREATE TABLE session_summaries (id INTEGER PRIMARY KEY, memory_session_id TEXT, project TEXT NOT NULL);
    `);
    db.run(`
      INSERT INTO sdk_sessions VALUES (1, 'resolved-content', 'resolved-memory', 'feat+resolved');
      INSERT INTO sdk_sessions VALUES (2, 'missing-content', 'missing-memory', 'feat+missing');
      INSERT INTO pending_messages VALUES (1, 'resolved-content', '${worktree.replaceAll("'", "''")}');
      INSERT INTO pending_messages VALUES (2, 'missing-content', '${path.join(root, 'missing').replaceAll("'", "''")}');
      INSERT INTO observations VALUES (1, 'resolved-memory', 'feat+resolved');
      INSERT INTO observations VALUES (2, 'missing-memory', 'feat+missing');
      INSERT INTO session_summaries VALUES (1, 'resolved-memory', 'feat+resolved');
      INSERT INTO session_summaries VALUES (2, 'missing-memory', 'feat+missing');
    `);
    db.close();

    runOneTimeBareWorktreeProjectMigration(dataDir);
    runOneTimeBareWorktreeProjectMigration(dataDir);

    const migrated = new Database(path.join(dataDir, 'claude-mem.db'));
    const sessionProjects = migrated.prepare('SELECT project FROM sdk_sessions ORDER BY id').all() as Array<{ project: string }>;
    const observationProjects = migrated.prepare('SELECT project FROM observations ORDER BY id').all() as Array<{ project: string }>;
    const summaryProjects = migrated.prepare('SELECT project FROM session_summaries ORDER BY id').all() as Array<{ project: string }>;
    migrated.close();

    expect(sessionProjects.map(row => row.project)).toEqual(['fixture-repo/feat+resolved', 'feat+missing']);
    expect(observationProjects.map(row => row.project)).toEqual(['fixture-repo/feat+resolved', 'feat+missing']);
    expect(summaryProjects.map(row => row.project)).toEqual(['fixture-repo/feat+resolved', 'feat+missing']);
  });
});
