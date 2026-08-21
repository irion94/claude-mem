import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'events';
import { ClaudeMemDatabase } from '../../../src/services/sqlite/Database.js';
import { PendingMessageStore } from '../../../src/services/sqlite/PendingMessageStore.js';
import { createSDKSession } from '../../../src/services/sqlite/Sessions.js';
import { SessionManager } from '../../../src/services/worker/SessionManager.js';
import type { DatabaseManager } from '../../../src/services/worker/DatabaseManager.js';
import type { Database } from 'bun:sqlite';
import { logger } from '../../../src/utils/logger.js';

interface ScheduledTimer {
  callback: () => void;
  delay: number;
  cleared: boolean;
}

describe('SessionManager observation batching', () => {
  let db: Database;
  let store: PendingMessageStore;
  let manager: SessionManager;
  let sessionDbId: number;
  let now: number;
  let timers: ScheduledTimer[];
  let flushes: number[];
  let settings: Record<string, string>;

  beforeEach(() => {
    (logger as unknown as { formatTool?: (name: string) => string }).formatTool ??= name => name;
    db = new ClaudeMemDatabase(':memory:').db;
    store = new PendingMessageStore(db, 3);
    sessionDbId = createSDKSession(db, 'batch-session', 'project', 'prompt');
    now = Date.now();
    timers = [];
    flushes = [];
    settings = {
      CLAUDE_MEM_BATCH_MAX_MESSAGES: '5',
      CLAUDE_MEM_BATCH_MAX_AGE_SEC: '300',
      CLAUDE_MEM_SUMMARY_MODE: 'batched',
    };

    const sessionRecord = {
      id: sessionDbId,
      content_session_id: 'batch-session',
      memory_session_id: null,
      project: 'project',
      platform_source: 'claude-code',
      user_prompt: 'prompt',
      custom_title: null,
      status: 'active',
    };
    const dbManager = {
      getSessionById: () => sessionRecord,
      getSessionStore: () => ({
        db,
        getPromptNumberFromUserPrompts: () => 1,
      }),
    } as unknown as DatabaseManager;

    manager = new SessionManager(dbManager, {
      getSettings: () => settings,
      now: () => now,
      setTimer: (callback, delay) => {
        const timer = { callback, delay, cleared: false };
        timers.push(timer);
        return timer as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: timer => {
        (timer as unknown as ScheduledTimer).cleared = true;
      },
    });
    (manager as unknown as { pendingStore: PendingMessageStore }).pendingStore = store;
    manager.setOnFlushRequested(id => flushes.push(id));
    manager.initializeSession(sessionDbId);
  });

  afterEach(() => {
    manager.removeSessionImmediate(sessionDbId);
    db.close();
  });

  const queueObservation = (tool = 'Read') => manager.queueObservation(sessionDbId, {
    tool_name: tool,
    tool_input: { path: tool },
    tool_response: { ok: true },
    prompt_number: 1,
  });

  test('flushes when pending observation count reaches MAX_MESSAGES', () => {
    settings.CLAUDE_MEM_BATCH_MAX_MESSAGES = '2';

    queueObservation('Read');
    expect(flushes).toHaveLength(0);
    queueObservation('Write');

    expect(flushes).toEqual([sessionDbId]);
    expect(manager.consumeFlushReason(sessionDbId)).toBe('count');
  });

  test('age deadline is based on the first message and is not extended', () => {
    settings.CLAUDE_MEM_BATCH_MAX_AGE_SEC = '10';

    queueObservation('Read');
    expect(timers[0].delay).toBe(10_000);
    now += 5_000;
    queueObservation('Write');

    expect(timers).toHaveLength(1);
    timers[0].callback();
    expect(manager.consumeFlushReason(sessionDbId)).toBe('age');
  });

  test('clears the age timer when a session is reaped', () => {
    queueObservation();
    expect(timers[0].cleared).toBe(false);

    manager.removeSessionImmediate(sessionDbId);

    expect(timers[0].cleared).toBe(true);
  });

  test('exit and startup explicitly flush pending work', () => {
    queueObservation();
    manager.flushSession(sessionDbId, 'exit');
    expect(manager.consumeFlushReason(sessionDbId)).toBe('exit');

    manager.flushSession(sessionDbId, 'startup');
    expect(manager.consumeFlushReason(sessionDbId)).toBe('startup');
  });

  test('new session initialization flushes orphan sessions', () => {
    queueObservation();
    const orphan = manager.getSession(sessionDbId)!;
    orphan.generatorPromise = null;

    const secondId = createSDKSession(db, 'second-session', 'project', 'prompt');
    manager.initializeSession(secondId);

    expect(manager.consumeFlushReason(sessionDbId)).toBe('new');
    manager.removeSessionImmediate(secondId);
  });

  test('three batched summarize requests remain pending until one observation flush', () => {
    manager.queueSummarize(sessionDbId, 'first');
    manager.queueSummarize(sessionDbId, 'second');
    manager.queueSummarize(sessionDbId, 'latest');
    expect(flushes).toHaveLength(0);
    expect(manager.getSession(sessionDbId)?.summaryRequested).toBe(true);
    expect(manager.getSession(sessionDbId)?.lastAssistantMessage).toBe('latest');

    manager.flushSession(sessionDbId, 'exit');
    const batch = store.claimPendingBatch(sessionDbId);

    expect(batch.filter(message => message.message_type === 'summarize')).toHaveLength(3);
    expect(batch.at(-1)?.last_assistant_message).toBe('latest');
  });

  test('MAX_MESSAGES=1 requests an immediate flush for every observation', () => {
    settings.CLAUDE_MEM_BATCH_MAX_MESSAGES = '1';

    queueObservation('Read');
    expect(manager.consumeFlushReason(sessionDbId)).toBe('count');
    queueObservation('Write');

    expect(flushes).toEqual([sessionDbId, sessionDbId]);
    expect(manager.consumeFlushReason(sessionDbId)).toBe('count');
  });

  test('SUMMARY_MODE=immediate requests a flush for each summarize', () => {
    settings.CLAUDE_MEM_SUMMARY_MODE = 'immediate';

    manager.queueSummarize(sessionDbId, 'one');
    expect(manager.consumeFlushReason(sessionDbId)).toBe('count');
    manager.queueSummarize(sessionDbId, 'two');

    expect(flushes).toEqual([sessionDbId, sessionDbId]);
    expect(manager.consumeFlushReason(sessionDbId)).toBe('count');
  });
});
