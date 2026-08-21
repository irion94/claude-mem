import { describe, expect, test } from 'bun:test';
import { buildObservationPrompt } from '../../src/sdk/prompts.js';

describe('buildObservationPrompt batching', () => {
  test('lists multiple tool events in one prompt', () => {
    const prompt = buildObservationPrompt([
      { tool_name: 'Read', tool_input: '{}', tool_output: '"a"', created_at_epoch: 1 } as any,
      { tool_name: 'Write', tool_input: '{}', tool_output: '"b"', created_at_epoch: 2 } as any,
    ]);

    expect(prompt.match(/<observed_from_primary_session>/g)).toHaveLength(2);
    expect(prompt).toContain('<what_happened>Read</what_happened>');
    expect(prompt).toContain('<what_happened>Write</what_happened>');
    expect(prompt.match(/Return either one or more/g)).toHaveLength(1);
  });
});
