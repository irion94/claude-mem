import { EventEmitter } from 'events';
import { PendingMessageStore, PersistentPendingMessage } from '../sqlite/PendingMessageStore.js';
import type { FlushReason, PendingMessageBatch, PendingMessageWithId } from '../worker-types.js';
import { logger } from '../../utils/logger.js';

const IDLE_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

export interface CreateIteratorOptions {
  sessionDbId: number;
  signal: AbortSignal;
  /** Called when idle timeout occurs - should trigger abort to kill subprocess */
  onIdleTimeout?: () => void;
  isFlushReady?: () => boolean;
  consumeFlushReason?: () => FlushReason | null;
  getClaimLimit?: () => number | undefined;
  getClaimMaxBytes?: () => number | undefined;
}

export class SessionQueueProcessor {
  constructor(
    private store: PendingMessageStore,
    private events: EventEmitter
  ) {}

  /**
   * Create an async iterator that yields messages as they become available.
   * Uses atomic claim-confirm to prevent duplicates.
   * Messages are claimed (marked processing) and stay in DB until confirmProcessed().
   * Self-heals stale processing messages before each claim.
   * Waits for 'message' event when queue is empty.
   *
   * CRITICAL: Calls onIdleTimeout callback after 3 minutes of inactivity.
   * The callback should trigger abortController.abort() to kill the SDK subprocess.
   * Just returning from the iterator is NOT enough - the subprocess stays alive!
   */
  async *createIterator(options: CreateIteratorOptions): AsyncIterableIterator<PendingMessageBatch> {
    const { sessionDbId, signal, onIdleTimeout, getClaimLimit, getClaimMaxBytes } = options;
    const isFlushReady = options.isFlushReady ?? (() => true);
    const consumeFlushReason = options.consumeFlushReason ?? (() => 'count');
    let lastActivityTime = Date.now();

    while (!signal.aborted) {
      if (isFlushReady()) {
        try {
          const reason = consumeFlushReason();
          const persistentMessages = typeof this.store.claimPendingBatch === 'function'
            ? this.store.claimPendingBatch(sessionDbId, getClaimLimit?.(), getClaimMaxBytes?.())
            : [this.store.claimNextMessage(sessionDbId)].filter((message): message is PersistentPendingMessage => message !== null);
          if (reason && persistentMessages.length > 0) {
            lastActivityTime = Date.now();
            yield {
              reason,
              messages: persistentMessages.map(message => this.toPendingMessageWithId(message)),
            };
            continue;
          }
        } catch (error) {
          if (signal.aborted) return;
          const normalizedError = error instanceof Error ? error : new Error(String(error));
          logger.error('QUEUE', 'Failed to claim pending batch', { sessionDbId }, normalizedError);
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }
      }

      // Wait phase: queue empty - wait for wake-up event or timeout
      try {
        const idleTimedOut = await this.handleWaitPhase(signal, lastActivityTime, sessionDbId, onIdleTimeout);
        if (idleTimedOut) return;
        // Reset timer on spurious wakeup if not timed out
        lastActivityTime = Date.now();
      } catch (error) {
        if (signal.aborted) return;
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        logger.error('QUEUE', 'Error waiting for message', { sessionDbId }, normalizedError);
        // Small backoff to prevent tight loop on error
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  private toPendingMessageWithId(msg: PersistentPendingMessage): PendingMessageWithId {
    const pending = this.store.toPendingMessage(msg);
    return {
      ...pending,
      _persistentId: msg.id,
      _originalTimestamp: msg.created_at_epoch
    };
  }

  /**
   * Handle the wait phase: wait for a message or check idle timeout.
   * @returns true if idle timeout was reached (caller should return/exit iterator)
   */
  private async handleWaitPhase(
    signal: AbortSignal,
    lastActivityTime: number,
    sessionDbId: number,
    onIdleTimeout?: () => void
  ): Promise<boolean> {
    const receivedMessage = await this.waitForMessage(signal, IDLE_TIMEOUT_MS);

    if (!receivedMessage && !signal.aborted) {
      const idleDuration = Date.now() - lastActivityTime;
      if (idleDuration >= IDLE_TIMEOUT_MS) {
        logger.info('SESSION', 'Idle timeout reached, triggering abort to kill subprocess', {
          sessionDbId,
          idleDurationMs: idleDuration,
          thresholdMs: IDLE_TIMEOUT_MS
        });
        onIdleTimeout?.();
        return true;
      }
    }
    return false;
  }

  /**
   * Wait for a message event or timeout.
   * @param signal - AbortSignal to cancel waiting
   * @param timeoutMs - Maximum time to wait before returning
   * @returns true if a message was received, false if timeout occurred
   */
  private waitForMessage(signal: AbortSignal, timeoutMs: number = IDLE_TIMEOUT_MS): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const onMessage = () => {
        cleanup();
        resolve(true); // Message received
      };

      const onAbort = () => {
        cleanup();
        resolve(false); // Aborted, let loop check signal.aborted
      };

      const onTimeout = () => {
        cleanup();
        resolve(false); // Timeout occurred
      };

      const cleanup = () => {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
        this.events.off('message', onMessage);
        signal.removeEventListener('abort', onAbort);
      };

      this.events.once('message', onMessage);
      signal.addEventListener('abort', onAbort, { once: true });
      timeoutId = setTimeout(onTimeout, timeoutMs);
    });
  }
}
