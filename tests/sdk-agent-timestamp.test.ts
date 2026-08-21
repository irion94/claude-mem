import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { ModeManager } from '../src/services/domain/ModeManager.js';
import type { ActiveSession, PendingMessageWithId } from '../src/services/worker-types.js';

mock.module('@anthropic-ai/claude-agent-sdk', () => ({ query: mock(() => []) }));
const { SDKAgent } = await import('../src/services/worker/SDKAgent.js');

describe('SDKAgent source-session timestamp', () => {
  afterEach(() => {
    (ModeManager.getInstance as any).mockRestore?.();
  });

  it('puts the pending message epoch in the observation prompt', async () => {
    const sourceEpoch = Date.UTC(2025, 3, 12, 10, 30, 0);
    const session = {
      sessionDbId: 1,
      contentSessionId: 'content-session',
      memorySessionId: 'memory-session',
      project: 'project',
      platformSource: 'claude',
      userPrompt: 'prompt',
      pendingMessages: [],
      abortController: new AbortController(),
      generatorPromise: null,
      lastPromptNumber: 1,
      startTime: Date.now(),
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      earliestPendingTimestamp: null,
      conversationHistory: [],
      currentProvider: 'claude',
      consecutiveRestarts: 0,
      lastGeneratorActivity: Date.now(),
      processingMessageIds: [],
      consecutiveSummaryFailures: 0
    } as ActiveSession;
    const pendingMessage: PendingMessageWithId = {
      type: 'observation',
      tool_name: 'Read',
      tool_input: { file_path: 'old.ts' },
      tool_response: { ok: true },
      _persistentId: 1,
      _originalTimestamp: sourceEpoch
    };
    const sessionManager = {
      getMessageIterator: async function* () {
        session.earliestPendingTimestamp = pendingMessage._originalTimestamp;
        yield { messages: [pendingMessage], reason: "count" as const };
      }
    };
    const mode = {
      prompts: {},
      observation_types: [],
      observation_concepts: []
    };
    spyOn(ModeManager, 'getInstance').mockReturnValue({ getActiveMode: () => mode } as any);
    const agent = new SDKAgent({} as any, sessionManager as any);
    const generator = (agent as any).createMessageGenerator(session, { lastCwd: undefined });

    await generator.next();
    const observationMessage = await generator.next();
    const prompt = observationMessage.value.message.content as string;

    expect(prompt).toContain(`<occurred_at>${new Date(sourceEpoch).toISOString()}</occurred_at>`);
  });
});
