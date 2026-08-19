import { formatSdkErrorMessage } from "../errors";
import type { Logger } from "../evaluate";
import type { ExposureBatchResult } from "../generated/contract-surface.js";
import { admitExposure, rearmExposureFlags } from "./exposure-admission";
import { type QueuedExposure, takeBatch, toExposureBatchItems } from "./exposure-batch";
import {
  applyExposureBatchResults,
  logBatchFailure,
  logMissingBatchResults,
  logRejectedItem,
  logZeroProgress,
  redeemExposureBatch,
} from "./exposure-drain";
import { ExposureOverflow } from "./exposure-overflow";
import { ExposureRetryPolicy } from "./exposure-retry";
import { resolveDocument, resolveWindow } from "./lifecycle-targets";
import type { BrowserTransport } from "./transport";

const FLUSH_DELAY_MS = 5_000;
/**
 * Caps redeem round-trips inside one drainPending call. Stops a drain that never
 * empties because new Exposures keep arriving during awaits. Zero-progress already
 * stops no-op loops; this bounds successful-but-endless drains. Not derived from
 * the per-request item cap.
 */
const MAX_BATCHES_PER_DRAIN = 10_000;

export type { QueuedExposure } from "./exposure-batch";

export interface ExposureQueueDeps {
  readonly transport: Pick<BrowserTransport, "redeemExposures">;
  readonly logger: Logger;
  readonly now: () => number;
  /** Injectable page lifecycle targets for tests. Explicit null means absent. */
  readonly document?: Document | null;
  readonly window?: Window | null;
  /** Test seam: override {@link MAX_BATCHES_PER_DRAIN}. */
  readonly maxBatchesPerDrain?: number;
}

/**
 * Memory-only Exposure Ticket redemption queue. Flush on timer, batch caps,
 * explicit `flush()`, and pagehide/`visibilitychange` via authenticated
 * `fetch` with `keepalive` (Authorization rules out `sendBeacon`).
 */
export class ExposureQueue {
  private readonly pending: QueuedExposure[] = [];
  private readonly enqueuedFlags = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lifecycleAttached = false;
  private closed = false;
  /** Shared so a second close() is a no-op (no second redeem); matches NO_RETRY copy. */
  private closePromise: Promise<readonly ExposureBatchResult[]> | null = null;
  /** In-flight drain; overlapping callers await this then continue. */
  private activeDrain: Promise<readonly ExposureBatchResult[]> | null = null;
  /** Callers currently inside enqueueDrain (includes waiters). */
  private queuedDrains = 0;
  private readonly overflow: ExposureOverflow;
  private readonly retryPolicy: ExposureRetryPolicy;

  private readonly onVisibilityChange = (): void => {
    if (resolveDocument(this.deps)?.visibilityState === "hidden") {
      void this.flushBestEffort({ keepalive: true });
    }
  };

  private readonly onPageHide = (): void => {
    void this.flushBestEffort({ keepalive: true });
  };

  constructor(private readonly deps: ExposureQueueDeps) {
    this.overflow = new ExposureOverflow(this.pending, this.enqueuedFlags, deps.logger);
    this.retryPolicy = new ExposureRetryPolicy(deps.logger);
  }

  /**
   * Enqueue one redemption for a Flag's server-issued ticket. Idempotent per
   * Flag Key for the current held payload: repeat calls are no-ops.
   */
  enqueue(flagKey: string, exposureTicket: string): void {
    if (this.closed) {
      this.deps.logger.error(
        formatSdkErrorMessage({
          code: "VALIDATION_ERROR",
          causeSummary: `Exposure for ${JSON.stringify(flagKey)} was discarded after close()`,
          remediation: "Do not read Flags after close(); construct a new client if needed",
        }),
        { flagKey },
      );
      return;
    }
    const atCapacity = admitExposure(
      this.pending,
      this.enqueuedFlags,
      this.deps.logger,
      this.deps.now,
      flagKey,
      exposureTicket,
    );
    if (atCapacity === null) {
      return;
    }
    this.ensureLifecycle();
    this.ensureTimer();
    if (atCapacity) {
      void this.overflow.flush(
        () => this.enqueueDrain({ keepalive: false, automatic: true }),
        this.retryPolicy,
      );
    }
  }

  /** Arm the next read after the server changes a Flag's resolution identity. */
  rearm(flagKeys: readonly string[]): void {
    rearmExposureFlags(this.enqueuedFlags, flagKeys);
  }

  async flush(): Promise<readonly ExposureBatchResult[]> {
    return this.enqueueDrain({ keepalive: false, automatic: false });
  }

  async close(): Promise<readonly ExposureBatchResult[]> {
    if (this.closePromise !== null) {
      return this.closePromise;
    }
    this.closed = true;
    this.clearTimer();
    this.closePromise = (async () => {
      try {
        return await this.enqueueDrain({ keepalive: false, automatic: false });
      } finally {
        this.detachLifecycle();
      }
    })();
    return this.closePromise;
  }

  private async flushBestEffort(options: { keepalive: boolean }): Promise<void> {
    try {
      await this.enqueueDrain({ keepalive: options.keepalive, automatic: true });
    } catch {
      // Best-effort page-lifecycle path: failures already logged in runOneBatch.
    }
  }

  /**
   * Start drain work synchronously until the first network await so a caller
   * that enqueues then flushes again cannot race takeBatch into one combined
   * batch. Hand off remaining pending when another drain is already queued
   * (so pagehide can send with keepalive).
   */
  private enqueueDrain(options: {
    keepalive: boolean;
    automatic: boolean;
  }): Promise<readonly ExposureBatchResult[]> {
    this.queuedDrains += 1;
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: ownership check/set must stay in one microtask
    return (async () => {
      try {
        while (this.activeDrain !== null) {
          try {
            await this.activeDrain;
          } catch {
            // The owner logged its failure. A waiter still gets its own send attempt.
          }
        }
        if (options.automatic && !this.retryPolicy.automaticRetryAllowed) {
          return [];
        }
        const work = this.drainPending(options.keepalive);
        this.activeDrain = work;
        try {
          return await work;
        } finally {
          if (this.activeDrain === work) {
            this.activeDrain = null;
          }
        }
      } finally {
        this.queuedDrains -= 1;
      }
    })();
  }

  private async drainPending(keepalive: boolean): Promise<readonly ExposureBatchResult[]> {
    const completed: ExposureBatchResult[] = [];
    const batchLimit = this.deps.maxBatchesPerDrain ?? MAX_BATCHES_PER_DRAIN;
    let batches = 0;
    try {
      while (this.pending.length > 0) {
        const [nextBatches, retainedForRetry] = await this.drainNextBatch(
          keepalive,
          batches,
          batchLimit,
          completed,
        );
        batches = nextBatches;
        if (
          (retainedForRetry && (!this.closed || !this.retryPolicy.automaticRetryAllowed)) ||
          this.queuedDrains > 1
        ) {
          break;
        }
      }
      return completed;
    } finally {
      this.afterDrain();
    }
  }

  private async drainNextBatch(
    keepalive: boolean,
    batches: number,
    batchLimit: number,
    completed: ExposureBatchResult[],
  ): Promise<readonly [batches: number, retainedForRetry: boolean]> {
    if (batches >= batchLimit) {
      throw logZeroProgress(
        this.deps.logger,
        `Exposure drain exceeded ${batchLimit} batches without clearing the queue`,
        this.pending.length,
      );
    }
    const outcome = await this.runOneBatch(keepalive);
    completed.push(...outcome.completed);
    return [batches + 1, outcome.retainedForRetry];
  }

  private afterDrain(): void {
    // Always re-arm (or clear) after a drain, including when runOneBatch throws:
    // a swallowed auto-flush failure must not permanently kill the 5s retry loop.
    if (this.automaticFlushAllowed()) {
      this.ensureTimer();
      this.ensureLifecycle();
      return;
    }
    this.clearTimer();
    this.detachLifecycle();
  }

  private async runOneBatch(
    keepalive: boolean,
  ): Promise<{ completed: readonly ExposureBatchResult[]; retainedForRetry: boolean }> {
    const batch = takeBatch(this.pending);
    const wireItems = toExposureBatchItems(batch);

    const result = await redeemExposureBatch(this.deps.transport, wireItems, keepalive);
    if (result.results === null) {
      this.overflow.retain(batch);
      throw logBatchFailure(
        this.deps.logger,
        result,
        batch.length,
        this.retryPolicy.remediationForFailure(result, batch.length, this.closed),
      );
    }

    let outcome: ReturnType<typeof applyExposureBatchResults>;
    try {
      outcome = applyExposureBatchResults(
        batch,
        result.results,
        result.status,
        (item, row, status) => logRejectedItem(this.deps.logger, item, row, status),
      );
    } catch (cause) {
      this.overflow.retain(batch);
      this.retryPolicy.recordFailure(result, batch.length);
      throw logZeroProgress(
        this.deps.logger,
        cause instanceof Error ? cause.message : "Exposure batch response is invalid",
        batch.length,
        cause,
      );
    }
    if (outcome.retained.length > 0) {
      this.overflow.retain(outcome.retained);
    }
    if (outcome.unmatchedCount > 0) {
      this.retryPolicy.recordFailure(result, outcome.retained.length);
      if (outcome.completed.length === 0) {
        throw logZeroProgress(
          this.deps.logger,
          "Exposure batch response made zero progress because it omitted one or more sent exposureIds",
          outcome.unmatchedCount,
        );
      }
      logMissingBatchResults(this.deps.logger, outcome.unmatchedCount);
      return { completed: outcome.completed, retainedForRetry: true };
    }
    if (outcome.retained.length > 0) {
      this.retryPolicy.recordFailure(result, outcome.retained.length);
      return { completed: outcome.completed, retainedForRetry: true };
    }
    this.retryPolicy.recordSuccess();
    return { completed: outcome.completed, retainedForRetry: false };
  }

  private automaticFlushAllowed(): boolean {
    return !this.closed && this.pending.length > 0 && this.retryPolicy.automaticRetryAllowed;
  }

  private ensureTimer(): void {
    if (this.flushTimer !== null || !this.automaticFlushAllowed()) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushBestEffort({ keepalive: false });
    }, FLUSH_DELAY_MS);
  }

  private clearTimer(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private ensureLifecycle(): void {
    if (this.lifecycleAttached || !this.automaticFlushAllowed()) {
      return;
    }
    const doc = resolveDocument(this.deps);
    const win = resolveWindow(this.deps);
    if (doc !== null) {
      doc.addEventListener("visibilitychange", this.onVisibilityChange);
    }
    if (win !== null) {
      win.addEventListener("pagehide", this.onPageHide);
    }
    if (doc !== null || win !== null) {
      this.lifecycleAttached = true;
    }
  }

  private detachLifecycle(): void {
    if (!this.lifecycleAttached) {
      return;
    }
    resolveDocument(this.deps)?.removeEventListener("visibilitychange", this.onVisibilityChange);
    resolveWindow(this.deps)?.removeEventListener("pagehide", this.onPageHide);
    this.lifecycleAttached = false;
  }
}
