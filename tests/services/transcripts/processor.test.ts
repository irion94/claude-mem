import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';

const sessionInits: unknown[] = [];
const observations: unknown[] = [];
const sessionCompletions: unknown[] = [];
const summaryRequests: unknown[] = [];

mock.module('../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: (key: string) => key === 'CLAUDE_MEM_DATA_DIR' ? join(homedir(), '.claude-mem') : '',
    loadFromFile: () => ({ CLAUDE_MEM_EXCLUDED_PROJECTS: '' }),
  },
}));

mock.module('../../../src/cli/handlers/session-init.js', () => ({
  sessionInitHandler: { execute: async (input: unknown) => { sessionInits.push(input); } },
}));

mock.module('../../../src/cli/handlers/observation.js', () => ({
  observationHandler: { execute: async (input: unknown) => { observations.push(input); } },
}));

mock.module('../../../src/cli/handlers/file-edit.js', () => ({
  fileEditHandler: { execute: async () => undefined },
}));

mock.module('../../../src/cli/handlers/session-complete.js', () => ({
  sessionCompleteHandler: { execute: async (input: unknown) => { sessionCompletions.push(input); } },
}));

mock.module('../../../src/shared/worker-utils.js', () => ({
  ensureWorkerRunning: async () => true,
  workerHttpRequest: async (path: string, options?: unknown) => {
    summaryRequests.push({ path, options });
    return new Response('', { status: 200 });
  },
}));

mock.module('../../../src/utils/agents-md-utils.js', () => ({
  writeAgentsMd: () => undefined,
}));

import { SAMPLE_CONFIG } from '../../../src/services/transcripts/config.js';
import { TranscriptEventProcessor } from '../../../src/services/transcripts/processor.js';
import { DATA_DIR } from '../../../src/shared/paths.js';
import { logger } from '../../../src/utils/logger.js';
import type { TranscriptSchema, WatchTarget } from '../../../src/services/transcripts/types.js';

const schema = SAMPLE_CONFIG.schemas!.codex as TranscriptSchema;
const watch: WatchTarget = {
  name: 'codex',
  path: '~/.codex/sessions/**/*.jsonl',
  schema: 'codex',
};
const sessionId = '11111111-1111-1111-1111-111111111111';

async function processRollout(cwd: string, filePath: string): Promise<void> {
  const processor = new TranscriptEventProcessor();
  const entries = [
    { type: 'session_meta', payload: { id: sessionId, cwd } },
    { type: 'response_item', payload: { type: 'user_message', message: 'test prompt' } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'call-1', name: 'exec_command', arguments: '{}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'done' } },
    { type: 'response_item', payload: { type: 'agent_message', message: 'finished' } },
    { type: 'response_item', payload: { type: 'turn_completed' } },
  ];

  for (const entry of entries) {
    await processor.processEntry(entry, watch, schema, sessionId, filePath);
  }
}

beforeEach(() => {
  sessionInits.length = 0;
  observations.length = 0;
  sessionCompletions.length = 0;
  summaryRequests.length = 0;
});

describe('TranscriptEventProcessor cwd filtering', () => {
  it('skips a self-observer rollout and logs once per transcript file', async () => {
    const infoSpy = spyOn(logger, 'info').mockImplementation(() => {});

    await processRollout(DATA_DIR, '/tmp/self-observer.jsonl');

    expect(sessionInits).toHaveLength(0);
    expect(observations).toHaveLength(0);
    expect(sessionCompletions).toHaveLength(0);
    expect(summaryRequests).toHaveLength(0);
    const skipLogs = infoSpy.mock.calls.filter(call => String(call[1]).includes('SKIP self-observer'));
    expect(skipLogs).toHaveLength(1);
    expect(skipLogs[0]?.[2]).toMatchObject({ cwd: DATA_DIR });
    infoSpy.mockRestore();
  });

  it('processes a rollout from a normal project', async () => {
    await processRollout('/tmp/project', '/tmp/project.jsonl');

    expect(sessionInits).toHaveLength(1);
    expect(observations).toHaveLength(1);
    expect(sessionCompletions).toHaveLength(1);
    expect(summaryRequests).toHaveLength(1);
  });
});
