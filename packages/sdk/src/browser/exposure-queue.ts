import { formatSdkErrorMessage } from "../errors";
import type { Logger } from "../evaluate";
import type { ExposureBatchItem, ExposureBatchResult } from "../generated/contract-surface.js";
import {
  EXPOSURE_BATCH_MAX_BODY_BYTES,
  EXPOSURE_BATCH_MAX_ITEMS,
} from "../generated/contract-surface.js";
import { mintExposureId, pendingBodyBytes, type QueuedExposure, takeBatch } from "./exposure-batch";
import {
  correlateBatchResults,
  logBatchFailure,
  logRejectedItem,
  logZeroProgress,
} from "./exposure-drain";
import { resolveDocument, resolveWindow } from "./lifecycle-targets";
import type { BrowserTransport } from "./transport";

const FLUSH_DELAY_MS = 5_000;
/** Defense-in-depth: never spin forever if a response makes zero progress. */
const MAX_DRAIN_BATCHES = EXPOSURE_BATCH_MAX_ITEMS * 4;

export type { QueuedExposure } from "./exposure-batch";

export interface ExposureQueueDeps {
  readonly transport: Pick<BrowserTransport, "redeemExposures">;
  readonly logger: Logger;
  readonly now: () => number;
  /** Injectable page lifecycle targets for tests. Explicit null means absent. */
  readonly document?: Document | null;
  readonly window?: Window | null;
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
  /** In-flight drain; overlapping callers await this then continue. */
  private activeDrain: Promise<readonly ExposureBatchResult[]> | null = null;
  /** Callers currently inside enqueueDrain (includes waiters). */
  private queuedDrains = 0;

  private readonly onVisibilityChange = (): void => {
    if (resolveDocument(this.deps)?.visibilityState === "hidden") {
      void this.flushBestEffort({ keepalive: true });
    }
  };

  private readonly onPageHide = (): void => {
    void this.flushBestEffort({ keepalive: true });
  };

  constructor(private readonly deps: ExposureQueueDeps) {}

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
    if (this.enqueuedFlags.has(flagKey)) {
      return;
    }
    const exposureId = mintExposureId(this.deps.logger, flagKey);
    this.enqueuedFlags.add(flagKey);
    this.pending.push({
      flagKey,
      exposureId,
      exposureTicket,
      clientTimestamp: new Date(this.deps.now()).toISOString(),
    });
    this.ensureLifecycle();
    this.ensureTimer();
    if (
      this.pending.length >= EXPOSURE_BATCH_MAX_ITEMS ||
      pendingBodyBytes(this.pending) > EXPOSURE_BATCH_MAX_BODY_BYTES
    ) {
      void this.flushOverflow();
    }
  }

  async flush(): Promise<readonly ExposureBatchResult[]> {
    return this.enqueueDrain({ keepalive: false });
  }

  async close(): Promise<readonly ExposureBatchResult[]> {
    this.closed = true;
    this.clearTimer();
    try {
      return await this.enqueueDrain({ keepalive: false });
    } finally {
      this.detachLifecycle();
    }
  }

  private async flushBestEffort(options: { keepalive: boolean }): Promise<void> {
    try {
      await this.enqueueDrain({ keepalive: options.keepalive });
    } catch {
      // Best-effort page-lifecycle path: failures already logged in runOneBatch.
    }
  }

  private async flushOverflow(): Promise<void> {
    const before = this.pending.length;
    try {
      await this.enqueueDrain({ keepalive: false });
    } catch {
      // Logged below when items remain after a genuine forced-flush failure.
    }
    if (this.pending.length > 0 && this.pending.length >= before) {
      const lost = this.pending.splice(0, this.pending.length);
      for (const item of lost) {
        this.enqueuedFlags.delete(item.flagKey);
      }
      this.deps.logger.error(
        formatSdkErrorMessage({
          code: "RATE_LIMITED",
          causeSummary: `Exposure queue overflow dropped ${lost.length} redemption(s) after a failed forced flush`,
          remediation:
            "Reduce concurrent first-reads or call flush() more often; retained exposureIds were discarded loudly",
        }),
        { droppedCount: lost.length, exposureIds: lost.map((item) => item.exposureId) },
      );
    }
  }

  /**
   * Start drain work synchronously until the first network await so a caller
   * that enqueues then flushes again cannot race takeBatch into one combined
   * batch. Hand off remaining pending when another drain is already queued
   * (so pagehide can send with keepalive).
   */
  private enqueueDrain(options: { keepalive: boolean }): Promise<readonly ExposureBatchResult[]> {
    this.queuedDrains += 1;
    return (async () => {
      try {
        while (this.activeDrain !== null) {
          await this.activeDrain;
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
    let batches = 0;
    while (this.pending.length > 0) {
      if (batches >= MAX_DRAIN_BATCHES) {
        throw logZeroProgress(
          this.deps.logger,
          `Exposure drain exceeded ${MAX_DRAIN_BATCHES} batches without clearing the queue`,
          this.pending.length,
        );
      }
      const batchCompleted = await this.runOneBatch(keepalive);
      // Progress is per-response: empty/unmatched results complete nothing.
      // Do not compare pending.length — items may enqueue during the await.
      if (batchCompleted.length === 0) {
        throw logZeroProgress(
          this.deps.logger,
          "Exposure batch response made zero progress (empty or unmatched results)",
          this.pending.length,
        );
      }
      completed.push(...batchCompleted);
      batches += 1;
      // Another flush/pagehide/close is waiting — let it continue with its options.
      if (this.queuedDrains > 1) {
        break;
      }
    }
    if (this.pending.length === 0) {
      this.clearTimer();
      this.detachLifecycle();
    } else if (!this.closed) {
      this.ensureTimer();
      this.ensureLifecycle();
    }
    return completed;
  }

  private async runOneBatch(keepalive: boolean): Promise<readonly ExposureBatchResult[]> {
    const batch = takeBatch(this.pending);
    const wireItems: ExposureBatchItem[] = batch.map(
      ({ exposureId, exposureTicket, clientTimestamp }) => ({
        exposureId,
        exposureTicket,
        clientTimestamp,
      }),
    );

    const result = await this.deps.transport.redeemExposures(wireItems, { keepalive });
    if (result.results === null) {
      this.pending.unshift(...batch);
      throw logBatchFailure(this.deps.logger, result, batch.length);
    }

    const { completed, retained } = correlateBatchResults(
      batch,
      result.results,
      result.status,
      (item, row, status) => logRejectedItem(this.deps.logger, item, row, status),
    );
    if (retained.length > 0) {
      this.pending.unshift(...retained);
    }
    return completed;
  }

  private ensureTimer(): void {
    if (this.flushTimer !== null || this.closed || this.pending.length === 0) {
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
    if (this.lifecycleAttached || this.closed || this.pending.length === 0) {
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
