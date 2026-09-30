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

  // deleteSession reaps supervisor-tracked processes of the live install, so
  // tests that reach it (reaper, shutdown) record the call instead.
  const stubDeleteSession = (): number[] => {
    const deleted: number[] = [];
    (manager as unknown as { deleteSession: (id: number) => Promise<void> }).deleteSession = async id => {
      deleted.push(id);
    };
    return deleted;
  };

  describe('SUMMARY_CADENCE', () => {
    const IDLE_DEFAULT_MS = 1_800_000;
    const idleTimers = () => timers.filter(timer => timer.delay === IDLE_DEFAULT_MS);

    test('every-stop (default) queues a summarize row per request', () => {
      expect(manager.queueSummarize(sessionDbId, 'one')).toBe('queued');
      expect(store.getPendingCount(sessionDbId)).toBe(1);
    });

    test('session-end defers summarize: no row, no flush, idle timer armed', () => {
      settings.CLAUDE_MEM_SUMMARY_CADENCE = 'session-end';

      expect(manager.queueSummarize(sessionDbId, 'first')).toBe('deferred');
      expect(manager.queueSummarize(sessionDbId, 'latest')).toBe('deferred');

      expect(store.getPendingCount(sessionDbId)).toBe(0);
      expect(flushes).toHaveLength(0);
      expect(manager.isFlushReady(sessionDbId)).toBe(false);
      expect(manager.getSession(sessionDbId)?.summaryRequested).toBe(true);
      expect(idleTimers()).toHaveLength(2);
      expect(idleTimers()[0].cleared).toBe(true);
      expect(idleTimers()[1].cleared).toBe(false);
    });

    test('session-end exit flush materializes one summary with the latest message', async () => {
      settings.CLAUDE_MEM_SUMMARY_CADENCE = 'session-end';
      manager.queueSummarize(sessionDbId, 'first');
      manager.queueSummarize(sessionDbId, 'latest');

      const done = manager.flushAndWait(sessionDbId, 'exit');

      expect(flushes).toEqual([sessionDbId]);
      expect(manager.consumeFlushReason(sessionDbId)).toBe('exit');
      expect(idleTimers().every(timer => timer.cleared)).toBe(true);
      const batch = store.claimPendingBatch(sessionDbId);
      expect(batch.map(message => message.message_type)).toEqual(['summarize']);
      expect(batch[0].last_assistant_message).toBe('latest');

      batch.forEach(message => store.confirmProcessed(message.id));
      manager.notifyQueueProcessed(sessionDbId);
      await done;
    });

    test('session-end exit flush carries pending observations and the summary together', async () => {
      settings.CLAUDE_MEM_SUMMARY_CADENCE = 'session-end';
      queueObservation('Read');
      manager.queueSummarize(sessionDbId, 'latest');

      const done = manager.flushAndWait(sessionDbId, 'exit');
      const batch = store.claimPendingBatch(sessionDbId);
      expect(batch.map(message => message.message_type)).toEqual(['observation', 'summarize']);

      batch.forEach(message => store.confirmProcessed(message.id));
      manager.notifyQueueProcessed(sessionDbId);
      await done;
    });

    test('session-end idle timer materializes and flushes the deferred summary', () => {
      settings.CLAUDE_MEM_SUMMARY_CADENCE = 'session-end';
      settings.CLAUDE_MEM_SUMMARY_IDLE_SEC = '60';
      manager.queueSummarize(sessionDbId, 'latest');

      const idle = timers.at(-1)!;
      expect(idle.delay).toBe(60_000);
      idle.callback();

      expect(flushes).toEqual([sessionDbId]);
      expect(manager.consumeFlushReason(sessionDbId)).toBe('idle');
      const batch = store.claimPendingBatch(sessionDbId);
      expect(batch.map(message => message.message_type)).toEqual(['summarize']);
      expect(batch[0].last_assistant_message).toBe('latest');
    });

    test('session-end summary is produced once even if exit follows the idle flush', async () => {
      settings.CLAUDE_MEM_SUMMARY_CADENCE = 'session-end';
      manager.queueSummarize(sessionDbId, 'latest');
      idleTimers()[0].callback();
      store.claimPendingBatch(sessionDbId).forEach(message => store.confirmProcessed(message.id));

      await manager.flushAndWait(sessionDbId, 'exit');

      expect(store.getPendingCount(sessionDbId)).toBe(0);
    });

    test('session-end observation activity re-arms the idle timer', () => {
      settings.CLAUDE_MEM_SUMMARY_CADENCE = 'session-end';
      manager.queueSummarize(sessionDbId, 'latest');
      expect(idleTimers()).toHaveLength(1);

      queueObservation('Read');

      expect(idleTimers()).toHaveLength(2);
      expect(idleTimers()[0].cleared).toBe(true);
      expect(idleTimers()[1].cleared).toBe(false);
    });

    test('session-end reaper keeps a session whose summary is still deferred', async () => {
      settings.CLAUDE_MEM_SUMMARY_CADENCE = 'session-end';
      const deleted = stubDeleteSession();
      manager.queueSummarize(sessionDbId, 'latest');
      manager.getSession(sessionDbId)!.startTime = 0;

      expect(await manager.reapStaleSessions()).toBe(0);
      expect(deleted).toEqual([]);
    });

    test('session-end shutdown persists a deferred summary for the startup flush', async () => {
      settings.CLAUDE_MEM_SUMMARY_CADENCE = 'session-end';
      const deleted = stubDeleteSession();
      manager.queueSummarize(sessionDbId, 'latest');

      await manager.shutdownAll();

      expect(deleted).toEqual([sessionDbId]);
      const batch = store.claimPendingBatch(sessionDbId);
      expect(batch.map(message => message.message_type)).toEqual(['summarize']);
      expect(batch[0].last_assistant_message).toBe('latest');
    });

    test('removing a session clears its deferred summary idle timer', () => {
      settings.CLAUDE_MEM_SUMMARY_CADENCE = 'session-end';
      manager.queueSummarize(sessionDbId, 'latest');

      manager.removeSessionImmediate(sessionDbId);

      expect(idleTimers()[0].cleared).toBe(true);
    });
  });
});
