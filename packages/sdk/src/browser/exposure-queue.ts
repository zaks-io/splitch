import { formatSdkErrorMessage, SplitchSdkError } from "../errors";
import type { Logger } from "../evaluate";
import type { ExposureBatchItem, ExposureBatchResult } from "../generated/contract-surface.js";
import {
  EXPOSURE_BATCH_MAX_BODY_BYTES,
  EXPOSURE_BATCH_MAX_ITEMS,
} from "../generated/contract-surface.js";
import type { BrowserExposuresResult, BrowserTransport } from "./transport";

const FLUSH_DELAY_MS = 5_000;

export interface QueuedExposure extends ExposureBatchItem {
  readonly flagKey: string;
}

export interface ExposureQueueDeps {
  readonly transport: Pick<BrowserTransport, "redeemExposures">;
  readonly logger: Logger;
  readonly now: () => number;
  /** Injectable page lifecycle targets for tests. */
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
  private flushing: Promise<readonly ExposureBatchResult[]> | null = null;

  private readonly onVisibilityChange = (): void => {
    const doc = this.deps.document ?? (typeof document !== "undefined" ? document : null);
    if (doc?.visibilityState === "hidden") {
      void this.flushBestEffort({ keepalive: true });
    }
  };

  private readonly onPageHide = (): void => {
    void this.flushBestEffort({ keepalive: true });
  };

  constructor(private readonly deps: ExposureQueueDeps) {}

  /** True when this Flag Key already has a pending or acknowledged enqueue for the held payload. */
  hasEnqueued(flagKey: string): boolean {
    return this.enqueuedFlags.has(flagKey);
  }

  /**
   * Enqueue one redemption for a Flag's server-issued ticket. Idempotent per
   * Flag Key for the current held payload: repeat calls are no-ops.
   */
  enqueue(flagKey: string, exposureTicket: string): void {
    if (this.closed || this.enqueuedFlags.has(flagKey)) {
      return;
    }
    const exposureId = mintExposureId(this.deps.logger, flagKey);
    const item: QueuedExposure = {
      flagKey,
      exposureId,
      exposureTicket,
      clientTimestamp: new Date(this.deps.now()).toISOString(),
    };
    this.enqueuedFlags.add(flagKey);
    this.pending.push(item);
    this.ensureLifecycle();
    this.ensureTimer();
    if (
      this.pending.length >= EXPOSURE_BATCH_MAX_ITEMS ||
      this.bodyBytes(this.pending) > EXPOSURE_BATCH_MAX_BODY_BYTES
    ) {
      void this.flushOverflow();
    }
  }

  /** Drop per-Flag arming so a later revalidation swap can redeem a new ticket. */
  clearArmedFlags(): void {
    this.enqueuedFlags.clear();
  }

  async flush(): Promise<readonly ExposureBatchResult[]> {
    return this.flushInternal({ keepalive: false, awaitAck: true });
  }

  async close(): Promise<readonly ExposureBatchResult[]> {
    this.closed = true;
    this.clearTimer();
    this.detachLifecycle();
    return this.flushInternal({ keepalive: false, awaitAck: true });
  }

  private async flushBestEffort(options: { keepalive: boolean }): Promise<void> {
    try {
      await this.flushInternal({ keepalive: options.keepalive, awaitAck: false });
    } catch {
      // Best-effort page-lifecycle path: failures already logged in flushInternal.
    }
  }

  private async flushOverflow(): Promise<void> {
    const before = this.pending.length;
    try {
      await this.flushInternal({ keepalive: false, awaitAck: true });
    } catch {
      // Logged below when items remain.
    }
    if (this.pending.length >= before && before > 0) {
      // Cap overflow that could not flush: fail loud with an explicit loss count.
      const lost = this.pending.splice(0, before);
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

  private async flushInternal(options: {
    keepalive: boolean;
    awaitAck: boolean;
  }): Promise<readonly ExposureBatchResult[]> {
    if (this.flushing !== null) {
      return options.awaitAck ? this.flushing : [];
    }
    if (this.pending.length === 0) {
      this.clearTimer();
      this.detachLifecycle();
      return [];
    }

    const work = this.runFlush(options.keepalive);
    this.flushing = work;
    try {
      return await work;
    } finally {
      this.flushing = null;
      if (this.pending.length === 0) {
        this.clearTimer();
        this.detachLifecycle();
      } else if (!this.closed) {
        this.ensureTimer();
        this.ensureLifecycle();
      }
    }
  }

  private async runFlush(keepalive: boolean): Promise<readonly ExposureBatchResult[]> {
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
      throw this.logBatchFailure(result, batch.length);
    }

    const retained: QueuedExposure[] = [];
    const completed: ExposureBatchResult[] = [];
    for (let index = 0; index < batch.length; index++) {
      const item = batch[index];
      const row = result.results[index];
      if (item === undefined) {
        continue;
      }
      if (row === undefined) {
        retained.push(item);
        continue;
      }
      completed.push(row);
      if (row.status === "rejected") {
        this.logRejectedItem(item, row, result.status);
      }
      // accepted | deduplicated — leave enqueuedFlags set so repeat reads stay quiet.
    }
    if (retained.length > 0) {
      this.pending.unshift(...retained);
    }
    return completed;
  }

  private logBatchFailure(result: BrowserExposuresResult, count: number): SplitchSdkError {
    const error = new SplitchSdkError({
      code: result.errorCode ?? "SERVICE_UNAVAILABLE",
      causeSummary: result.errorMessage ?? "Exposure batch flush failed",
      remediation: "Retry flush(); pending exposureIds are retained unchanged",
      status: result.status,
      originalError: result.cause,
    });
    this.deps.logger.error(error.message, {
      status: result.status,
      errorCode: error.code,
      count,
      cause: result.cause,
    });
    return error;
  }

  private logRejectedItem(
    item: QueuedExposure,
    row: ExposureBatchResult,
    status: number | null,
  ): void {
    this.deps.logger.error(
      formatSdkErrorMessage({
        code: row.code ?? "VALIDATION_ERROR",
        causeSummary: `Exposure redemption rejected for ${item.exposureId}`,
        remediation:
          "Refetch Precomputed Evaluations if the ticket expired; otherwise inspect the error code",
        status,
      }),
      { exposureId: item.exposureId, flagKey: item.flagKey, code: row.code },
    );
  }

  private bodyBytes(items: readonly QueuedExposure[]): number {
    const wire = {
      exposures: items.map(({ exposureId, exposureTicket, clientTimestamp }) => ({
        exposureId,
        exposureTicket,
        clientTimestamp,
      })),
    };
    return new TextEncoder().encode(JSON.stringify(wire)).byteLength;
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
    const doc = this.deps.document ?? (typeof document !== "undefined" ? document : null);
    const win = this.deps.window ?? (typeof window !== "undefined" ? window : null);
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
    const doc = this.deps.document ?? (typeof document !== "undefined" ? document : null);
    const win = this.deps.window ?? (typeof window !== "undefined" ? window : null);
    doc?.removeEventListener("visibilitychange", this.onVisibilityChange);
    win?.removeEventListener("pagehide", this.onPageHide);
    this.lifecycleAttached = false;
  }
}

function takeBatch(pending: QueuedExposure[]): QueuedExposure[] {
  if (pending.length === 0) {
    return [];
  }
  const end = batchEndIndex(pending);
  return pending.splice(0, end);
}

/** How many leading pending items fit under both batch caps. */
function batchEndIndex(pending: readonly QueuedExposure[]): number {
  let end = 0;
  let bytes = bodyPrefixBytes();
  for (const next of pending) {
    if (end >= EXPOSURE_BATCH_MAX_ITEMS) {
      break;
    }
    const itemBytes = itemWireBytes(next) + (end === 0 ? 0 : 1);
    if (end > 0 && bytes + itemBytes + 2 > EXPOSURE_BATCH_MAX_BODY_BYTES) {
      break;
    }
    bytes += itemBytes;
    end += 1;
  }
  // Single oversize item: still send it alone so the Worker rejects loudly.
  return end === 0 ? 1 : end;
}

function bodyPrefixBytes(): number {
  // {"exposures":[]}
  return 16;
}

function itemWireBytes(item: QueuedExposure): number {
  return new TextEncoder().encode(
    JSON.stringify({
      exposureId: item.exposureId,
      exposureTicket: item.exposureTicket,
      clientTimestamp: item.clientTimestamp,
    }),
  ).byteLength;
}

function mintExposureId(logger: Logger, flagKey: string): string {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    const error = new SplitchSdkError({
      code: "SDK_IDEMPOTENCY_KEY_UNAVAILABLE",
      causeSummary:
        "crypto.randomUUID is unavailable, so the browser client could not mint an exposureId",
      remediation:
        "Serve the page from a secure context (https:// or localhost) where crypto.randomUUID exists",
    });
    logger.error(error.message, { flagKey, errorCode: error.code });
    throw error;
  }
  return globalThis.crypto.randomUUID();
}
