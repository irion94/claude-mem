import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

describe('SessionStore observation timestamps', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('stores the source-session epoch separately from the ingest epoch', () => {
    const sourceEpoch = Date.UTC(2025, 3, 12, 10, 30, 0);
    const sessionId = store.createSDKSession('content-session', 'project', 'prompt');
    store.ensureMemorySessionIdRegistered(sessionId, 'memory-session');
    const beforeIngest = Date.now();

    store.storeObservations(
      'memory-session',
      'project',
      [{
        type: 'discovery',
        title: 'Old transcript discovery',
        subtitle: null,
        facts: [],
        narrative: 'Recovered from an old pending message.',
        concepts: [],
        files_read: [],
        files_modified: []
      }],
      {
        request: 'Summarize old work',
        investigated: 'Historical transcript',
        learned: 'Source time must be retained',
        completed: 'Timestamp repair',
        next_steps: '',
        notes: null
      },
      1,
      0,
      sourceEpoch
    );

    const observation = store.db.prepare(
      'SELECT created_at_epoch, ingested_at_epoch FROM observations'
    ).get() as { created_at_epoch: number; ingested_at_epoch: number };
    const summary = store.db.prepare(
      'SELECT created_at_epoch FROM session_summaries'
    ).get() as { created_at_epoch: number };

    expect(observation.created_at_epoch).toBe(sourceEpoch);
    expect(summary.created_at_epoch).toBe(sourceEpoch);
    expect(observation.ingested_at_epoch).toBeGreaterThanOrEqual(beforeIngest);
    expect(observation.ingested_at_epoch).toBeLessThanOrEqual(Date.now());
  });
});
