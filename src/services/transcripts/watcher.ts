import { existsSync, statSync, watch as fsWatch, createReadStream } from 'fs';
import { basename, join } from 'path';
import { globSync } from 'glob';
import { logger } from '../../utils/logger.js';
import { expandHomePath } from './config.js';
import { loadWatchState, saveWatchState, type TranscriptWatchState } from './state.js';
import type { TranscriptWatchConfig, TranscriptSchema, WatchTarget } from './types.js';
import { TranscriptEventProcessor } from './processor.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';

type WatcherSettings = Pick<ReturnType<typeof SettingsDefaultsManager.loadFromFile>,
  'CLAUDE_MEM_TRANSCRIPTS_MAX_AGE_HOURS' | 'CLAUDE_MEM_TRANSCRIPTS_MAX_TAILERS'>;

interface TranscriptWatcherOptions {
  getSettings?: () => Partial<WatcherSettings>;
  now?: () => number;
}

const DEFAULT_MAX_AGE_HOURS = 48;
const DEFAULT_MAX_TAILERS = 512;

interface TailState {
  offset: number;
  partial: string;
}

class FileTailer {
  private watcher: ReturnType<typeof fsWatch> | null = null;
  private tailState: TailState;

  constructor(
    private filePath: string,
    initialOffset: number,
    private onLine: (line: string) => Promise<void>,
    private onOffset: (offset: number) => void
  ) {
    this.tailState = { offset: initialOffset, partial: '' };
  }

  start(): void {
    this.readNewData().catch(() => undefined);
    this.watcher = fsWatch(this.filePath, { persistent: true }, () => {
      this.readNewData().catch(() => undefined);
    });
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  private async readNewData(): Promise<void> {
    if (!existsSync(this.filePath)) return;

    let size = 0;
    try {
      size = statSync(this.filePath).size;
    } catch (error: unknown) {
      logger.debug('WORKER', 'Failed to stat transcript file', { file: this.filePath }, error instanceof Error ? error : undefined);
      return;
    }

    if (size < this.tailState.offset) {
      this.tailState.offset = 0;
    }

    if (size === this.tailState.offset) return;

    const stream = createReadStream(this.filePath, {
      start: this.tailState.offset,
      end: size - 1,
      encoding: 'utf8'
    });

    let data = '';
    for await (const chunk of stream) {
      data += chunk as string;
    }

    this.tailState.offset = size;
    this.onOffset(this.tailState.offset);

    const combined = this.tailState.partial + data;
    const lines = combined.split('\n');
    this.tailState.partial = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      await this.onLine(trimmed);
    }
  }
}

export class TranscriptWatcher {
  private processor = new TranscriptEventProcessor();
  private tailers = new Map<string, FileTailer>();
  private state: TranscriptWatchState;
  private rescanTimers: Array<NodeJS.Timeout> = [];
  // Size of each file present at startup: with `startAtEnd`, a file that only gets a
  // tailer later (it turned fresh) resumes from here instead of replaying its backlog.
  private startupSizes = new Map<string, number>();
  // Skipped-file count of the last cap warning per watch, to warn on change only.
  private capWarnedSkipped = new Map<string, number>();
  private getSettings: () => Partial<WatcherSettings>;
  private now: () => number;

  constructor(private config: TranscriptWatchConfig, private statePath: string, options: TranscriptWatcherOptions = {}) {
    this.state = loadWatchState(statePath);
    this.getSettings = options.getSettings ?? (() => SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH));
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    for (const watch of this.config.watches) {
      await this.setupWatch(watch);
    }
  }

  stop(): void {
    for (const tailer of this.tailers.values()) {
      tailer.close();
    }
    this.tailers.clear();
    for (const timer of this.rescanTimers) {
      clearInterval(timer);
    }
    this.rescanTimers = [];
  }

  private async setupWatch(watch: WatchTarget): Promise<void> {
    const schema = this.resolveSchema(watch);
    if (!schema) {
      logger.warn('TRANSCRIPT', 'Missing schema for watch', { watch: watch.name });
      return;
    }

    const resolvedPath = expandHomePath(watch.path);
    await this.syncTailers(resolvedPath, watch, schema, true);

    const rescanIntervalMs = watch.rescanIntervalMs ?? 5000;
      const timer = setInterval(async () => {
      await this.syncTailers(resolvedPath, watch, schema, false);
    }, rescanIntervalMs);
    this.rescanTimers.push(timer);
  }

  private getLimits(): { maxAgeMs: number; maxTailers: number } {
    const settings = this.getSettings();
    const parsedMaxAgeHours = parseFloat(settings.CLAUDE_MEM_TRANSCRIPTS_MAX_AGE_HOURS ?? String(DEFAULT_MAX_AGE_HOURS));
    const parsedMaxTailers = parseInt(settings.CLAUDE_MEM_TRANSCRIPTS_MAX_TAILERS ?? String(DEFAULT_MAX_TAILERS), 10);
    const maxAgeHours = Number.isFinite(parsedMaxAgeHours) ? parsedMaxAgeHours : DEFAULT_MAX_AGE_HOURS;
    return {
      maxAgeMs: maxAgeHours > 0 ? maxAgeHours * 60 * 60 * 1000 : Infinity,
      maxTailers: Number.isFinite(parsedMaxTailers) && parsedMaxTailers > 0 ? parsedMaxTailers : DEFAULT_MAX_TAILERS,
    };
  }

  /**
   * Tail the freshest files of a watch: only files whose mtime is inside the age
   * window, at most `maxTailers` in total across all watches. Tailers whose file
   * fell out of that set are closed (one fs.watch fd per tailer).
   */
  private async syncTailers(
    resolvedPath: string,
    watch: WatchTarget,
    schema: TranscriptSchema,
    initialDiscovery: boolean
  ): Promise<void> {
    const { maxAgeMs, maxTailers } = this.getLimits();
    const now = this.now();
    const files = this.resolveWatchFiles(resolvedPath);

    const fresh: Array<{ filePath: string; mtimeMs: number }> = [];
    for (const filePath of files) {
      try {
        const { mtimeMs, size } = statSync(filePath);
        if (initialDiscovery) this.startupSizes.set(filePath, size);
        if (now - mtimeMs <= maxAgeMs) fresh.push({ filePath, mtimeMs });
      } catch (error: unknown) {
        logger.debug('WORKER', 'Failed to stat transcript file for age check', { file: filePath }, error instanceof Error ? error : undefined);
      }
    }
    fresh.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const ownTailers = files.filter(filePath => this.tailers.has(filePath)).length;
    const slots = Math.max(0, maxTailers - (this.tailers.size - ownTailers));
    const keep = new Set(fresh.slice(0, slots).map(entry => entry.filePath));

    for (const filePath of files) {
      const tailer = this.tailers.get(filePath);
      if (tailer && !keep.has(filePath)) {
        tailer.close();
        this.tailers.delete(filePath);
        logger.debug('WORKER', 'Stopped watching transcript file', { file: filePath, watch: watch.name });
      }
    }

    for (const filePath of keep) {
      await this.addTailer(filePath, watch, schema);
    }

    const skipped = Math.max(0, fresh.length - slots);
    if (skipped === 0) {
      this.capWarnedSkipped.delete(watch.name);
    } else if (this.capWarnedSkipped.get(watch.name) !== skipped) {
      this.capWarnedSkipped.set(watch.name, skipped);
      logger.warn('WORKER', 'Transcript tailer cap reached, skipping older files', {
        watch: watch.name,
        maxTailers,
        fresh: fresh.length,
        skipped
      });
    }
  }

  private resolveSchema(watch: WatchTarget): TranscriptSchema | null {
    if (typeof watch.schema === 'string') {
      return this.config.schemas?.[watch.schema] ?? null;
    }
    return watch.schema;
  }

  private resolveWatchFiles(inputPath: string): string[] {
    if (this.hasGlob(inputPath)) {
      return globSync(inputPath, { nodir: true, absolute: true });
    }

    if (existsSync(inputPath)) {
      try {
        const stat = statSync(inputPath);
        if (stat.isDirectory()) {
          const pattern = join(inputPath, '**', '*.jsonl');
          return globSync(pattern, { nodir: true, absolute: true });
        }
        return [inputPath];
      } catch (error: unknown) {
        logger.debug('WORKER', 'Failed to stat watch path', { path: inputPath }, error instanceof Error ? error : undefined);
        return [];
      }
    }

    return [];
  }

  private hasGlob(inputPath: string): boolean {
    return /[*?[\]{}()]/.test(inputPath);
  }

  private async addTailer(
    filePath: string,
    watch: WatchTarget,
    schema: TranscriptSchema
  ): Promise<void> {
    if (this.tailers.has(filePath)) return;

    const sessionIdOverride = this.extractSessionIdFromPath(filePath);

    let offset = this.state.offsets[filePath] ?? 0;
    // `startAtEnd` is useful for files present at worker startup to avoid replaying the full
    // backlog, but new transcript files must be read from byte 0 or we lose session_meta/user_message.
    // A startup file tailed later resumes from its startup size, so appends made since are kept.
    if (offset === 0 && watch.startAtEnd) {
      offset = this.startupSizes.get(filePath) ?? 0;
    }

    const tailer = new FileTailer(
      filePath,
      offset,
      async (line: string) => {
        await this.handleLine(line, watch, schema, filePath, sessionIdOverride);
      },
      (newOffset: number) => {
        this.state.offsets[filePath] = newOffset;
        saveWatchState(this.statePath, this.state);
      }
    );

    tailer.start();
    this.tailers.set(filePath, tailer);
    logger.info('TRANSCRIPT', 'Watching transcript file', {
      file: filePath,
      watch: watch.name,
      schema: schema.name
    });
  }

  private async handleLine(
    line: string,
    watch: WatchTarget,
    schema: TranscriptSchema,
    filePath: string,
    sessionIdOverride?: string | null
  ): Promise<void> {
    try {
      const entry = JSON.parse(line);
      await this.processor.processEntry(entry, watch, schema, sessionIdOverride ?? undefined, filePath);
    } catch (error: unknown) {
      if (error instanceof Error) {
        logger.debug('TRANSCRIPT', 'Failed to parse transcript line', {
          watch: watch.name,
          file: basename(filePath)
        }, error);
      } else {
        logger.warn('TRANSCRIPT', 'Failed to parse transcript line (non-Error thrown)', {
          watch: watch.name,
          file: basename(filePath),
          error: String(error)
        });
      }
    }
  }

  private extractSessionIdFromPath(filePath: string): string | null {
    const match = filePath.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return match ? match[0] : null;
  }
}
