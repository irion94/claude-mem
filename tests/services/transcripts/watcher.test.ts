import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SAMPLE_CONFIG } from '../../../src/services/transcripts/config.js';
import { TranscriptWatcher } from '../../../src/services/transcripts/watcher.js';
import { logger } from '../../../src/utils/logger.js';
import type { TranscriptSchema, WatchTarget } from '../../../src/services/transcripts/types.js';

const HOUR_MS = 60 * 60 * 1000;
const schema = SAMPLE_CONFIG.schemas!.codex as TranscriptSchema;

let dir: string;
let watcher: TranscriptWatcher | null = null;
let warnSpy: ReturnType<typeof spyOn>;

function makeFile(name: string, mtimeMs: number): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, '');
  const seconds = mtimeMs / 1000;
  utimesSync(filePath, seconds, seconds);
  return filePath;
}

function createWatcher(
  settings: { CLAUDE_MEM_TRANSCRIPTS_MAX_AGE_HOURS?: string; CLAUDE_MEM_TRANSCRIPTS_MAX_TAILERS?: string },
  now: () => number,
  rescanIntervalMs = 60_000
): TranscriptWatcher {
  const watch: WatchTarget = { name: 'test', path: dir, schema, rescanIntervalMs };
  watcher = new TranscriptWatcher(
    { version: 1, watches: [watch] },
    join(dir, 'state', 'state.json'),
    { getSettings: () => settings, now }
  );
  return watcher;
}

function tailers(w: TranscriptWatcher): Map<string, { close(): void }> {
  return (w as unknown as { tailers: Map<string, { close(): void }> }).tailers;
}

function capWarnings(): unknown[][] {
  return warnSpy.mock.calls.filter(call => String(call[1]).toLowerCase().includes('cap'));
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('TranscriptWatcher tailer limits', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'transcript-watcher-test-'));
    warnSpy = spyOn(logger, 'warn');
  });

  afterEach(() => {
    watcher?.stop();
    watcher = null;
    warnSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('tails only files whose mtime is inside the age window', async () => {
    const now = Date.now();
    for (let i = 0; i < 1000; i++) {
      makeFile(`stale-${i}.jsonl`, now - 72 * HOUR_MS);
    }
    const fresh = makeFile('fresh.jsonl', now - HOUR_MS);

    const w = createWatcher({ CLAUDE_MEM_TRANSCRIPTS_MAX_AGE_HOURS: '48', CLAUDE_MEM_TRANSCRIPTS_MAX_TAILERS: '512' }, () => now);
    await w.start();

    expect([...tailers(w).keys()]).toEqual([fresh]);
  });

  it('closes a tailer on rescan once its file ages past the window', async () => {
    let now = Date.now();
    const fresh = makeFile('fresh.jsonl', now - HOUR_MS);

    const w = createWatcher({ CLAUDE_MEM_TRANSCRIPTS_MAX_AGE_HOURS: '48' }, () => now, 10);
    await w.start();

    const tailer = tailers(w).get(fresh)!;
    expect(tailer).toBeDefined();
    const closeSpy = spyOn(tailer, 'close');

    now += 48 * HOUR_MS;
    await waitFor(() => tailers(w).size === 0);

    expect(closeSpy).toHaveBeenCalled();
    expect(tailers(w).has(fresh)).toBe(false);
  });

  it('caps the number of tailers, keeps the freshest files and warns once', async () => {
    const now = Date.now();
    const files: string[] = [];
    for (let i = 0; i < 5; i++) {
      files.push(makeFile(`fresh-${i}.jsonl`, now - (i + 1) * 60_000));
    }

    const w = createWatcher({ CLAUDE_MEM_TRANSCRIPTS_MAX_AGE_HOURS: '48', CLAUDE_MEM_TRANSCRIPTS_MAX_TAILERS: '3' }, () => now);
    await w.start();

    expect([...tailers(w).keys()].sort()).toEqual(files.slice(0, 3).sort());
    expect(capWarnings()).toHaveLength(1);
  });

  it('warns about the cap once while the skipped set is unchanged', async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      makeFile(`fresh-${i}.jsonl`, now - (i + 1) * 60_000);
    }

    const w = createWatcher({ CLAUDE_MEM_TRANSCRIPTS_MAX_TAILERS: '3' }, () => now, 10);
    await w.start();
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(capWarnings()).toHaveLength(1);
  });

  it('reads a startup file that turns fresh from its size at startup (startAtEnd)', async () => {
    const now = Date.now();
    const filePath = join(dir, 'resumed.jsonl');
    writeFileSync(filePath, '{"old":true}\n');
    utimesSync(filePath, (now - 72 * HOUR_MS) / 1000, (now - 72 * HOUR_MS) / 1000);

    const watch: WatchTarget = { name: 'test', path: dir, schema, rescanIntervalMs: 10, startAtEnd: true };
    const w = new TranscriptWatcher(
      { version: 1, watches: [watch] },
      join(dir, 'state', 'state.json'),
      { getSettings: () => ({}), now: () => now }
    );
    watcher = w;
    const lines: string[] = [];
    spyOn(w as unknown as { handleLine: (line: string) => Promise<void> }, 'handleLine')
      .mockImplementation(async (line: string) => { lines.push(line); });

    await w.start();
    expect(tailers(w).size).toBe(0);

    appendFileSync(filePath, '{"new":true}\n');
    await waitFor(() => lines.length > 0);

    expect(lines).toEqual(['{"new":true}']);
  });

  it('closes the tailer of a deleted file on rescan and frees its slot', async () => {
    const now = Date.now();
    const gone = makeFile('gone.jsonl', now - 60_000);
    makeFile('waiting.jsonl', now - 120_000);

    const w = createWatcher({ CLAUDE_MEM_TRANSCRIPTS_MAX_TAILERS: '1' }, () => now, 10);
    await w.start();
    expect([...tailers(w).keys()]).toEqual([gone]);

    unlinkSync(gone);
    await waitFor(() => !tailers(w).has(gone) && tailers(w).size === 1);

    expect([...tailers(w).keys()]).toEqual([join(dir, 'waiting.jsonl')]);
  });

  it('persists the offset before a trailing partial line, so a re-added tailer keeps it', async () => {
    const now = Date.now();
    const filePath = join(dir, 'partial.jsonl');
    writeFileSync(filePath, '{"a":1}\n{"b":');

    const w = createWatcher({}, () => now);
    const lines: string[] = [];
    spyOn(w as unknown as { handleLine: (line: string) => Promise<void> }, 'handleLine')
      .mockImplementation(async (line: string) => { lines.push(line); });
    await w.start();
    await waitFor(() => lines.length === 1);

    const state = JSON.parse(readFileSync(join(dir, 'state', 'state.json'), 'utf-8'));
    expect(state.offsets[filePath]).toBe(Buffer.byteLength('{"a":1}\n'));
  });

  it('disables the age filter when max age is 0', async () => {
    const now = Date.now();
    const stale = makeFile('stale.jsonl', now - 720 * HOUR_MS);

    const w = createWatcher({ CLAUDE_MEM_TRANSCRIPTS_MAX_AGE_HOURS: '0' }, () => now);
    await w.start();

    expect([...tailers(w).keys()]).toEqual([stale]);
  });

  it('falls back to the 48h default when max age is unparsable', async () => {
    const now = Date.now();
    makeFile('stale.jsonl', now - 72 * HOUR_MS);
    const fresh = makeFile('fresh.jsonl', now - 24 * HOUR_MS);

    const w = createWatcher({ CLAUDE_MEM_TRANSCRIPTS_MAX_AGE_HOURS: 'abc' }, () => now);
    await w.start();

    expect([...tailers(w).keys()]).toEqual([fresh]);
  });
});
