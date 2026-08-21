import { describe, expect, it, mock, spyOn } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';

const workerCalls: string[] = [];
const selfObserverCwd = '/tmp/claude-mem-self-observer';

mock.module('../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: (key: string) => key === 'CLAUDE_MEM_DATA_DIR' ? join(homedir(), '.claude-mem') : '',
    loadFromFile: () => ({ CLAUDE_MEM_EXCLUDED_PROJECTS: '' }),
  },
}));

mock.module('../../../src/shared/worker-utils.js', () => ({
  ensureWorkerRunning: async () => true,
  workerHttpRequest: async (path: string) => {
    workerCalls.push(path);
    return new Response('', { status: 200 });
  },
}));

mock.module('../../../src/utils/project-filter.js', () => ({
  isProjectExcluded: () => false,
  isSelfObserverCwd: (cwd: string, dataDir?: string) => cwd === selfObserverCwd
    || (Boolean(dataDir) && (cwd === dataDir || cwd.startsWith(`${dataDir}/`))),
}));

import { observationHandler } from '../../../src/cli/handlers/observation.js';
import { logger } from '../../../src/utils/logger.js';

describe('observationHandler self-observer guard', () => {
  it('returns early without posting the observation', async () => {
    workerCalls.length = 0;
    const debugSpy = spyOn(logger, 'debug').mockImplementation(() => {});

    const result = await observationHandler.execute({
      sessionId: 'observer-session',
      cwd: selfObserverCwd,
      toolName: 'Bash',
      toolInput: { command: 'echo observer' },
      toolResponse: 'ok',
      platform: 'codex',
    });

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(workerCalls).toHaveLength(0);
    expect(debugSpy.mock.calls.some(call => String(call[1]).includes('Self-observer'))).toBe(true);
    debugSpy.mockRestore();
  });
});
