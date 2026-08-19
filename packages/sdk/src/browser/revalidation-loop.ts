import { SplitchSdkError } from "../errors";
import type { Logger } from "../evaluate";
import { sdkErrorForFailure } from "../evaluate";
import type { EvaluateAllEntry } from "../generated/contract-surface.js";
import type { AttributeValue } from "../transport";
import { loudly, mintIdempotencyKey } from "./client-helpers";
import type { BrowserEvaluateAllResult, BrowserTransport } from "./transport";

interface RevalidationContext {
  readonly targetingKey: string;
  readonly idType: string;
  readonly attributes: Readonly<Record<string, AttributeValue>>;
}

export interface RevalidationLoopDeps {
  readonly transport: Pick<BrowserTransport, "evaluateAll">;
  readonly logger: Logger;
  readonly context: RevalidationContext;
  readonly intervalMs: number;
  readonly getEtag: () => string;
  readonly onPayload: (
    evaluations: Readonly<Record<string, EvaluateAllEntry>>,
    etag: string,
  ) => void;
  readonly onNotModified: () => void;
  readonly onFailure: () => void;
}

/** Non-overlapping recursive timeout loop; the next tick starts after this one settles. */
export class RevalidationLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private stopped = false;

  constructor(private readonly deps: RevalidationLoopDeps) {}

  start(): void {
    if (this.started || this.stopped || this.deps.intervalMs === 0) {
      return;
    }
    this.started = true;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().finally(() => this.schedule());
    }, this.deps.intervalMs);
  }

  private async tick(): Promise<void> {
    let idempotencyKey: string;
    try {
      idempotencyKey = mintIdempotencyKey(this.deps.logger, this.deps.context.targetingKey);
    } catch {
      this.deps.onFailure();
      return;
    }

    let result: BrowserEvaluateAllResult;
    try {
      result = await this.deps.transport.evaluateAll({
        ...this.deps.context,
        idempotencyKey,
        ifNoneMatch: this.deps.getEtag(),
      });
    } catch (cause) {
      this.fail(
        new SplitchSdkError({
          code: "SDK_TRANSPORT_NETWORK",
          causeSummary: cause instanceof Error ? cause.message : "Revalidation transport rejected",
          remediation:
            "Correct the browser transport, then allow the next revalidation tick to retry",
          originalError: cause,
        }),
        cause,
      );
      return;
    }
    if (this.stopped) {
      return;
    }
    if (result.status === 304) {
      this.deps.onNotModified();
      return;
    }
    if (result.status === 200 && result.evaluations !== null && result.etag !== null) {
      this.deps.onPayload(result.evaluations, result.etag);
      return;
    }
    this.fail(sdkErrorForFailure("evaluateAll revalidation", result), result.cause);
  }

  private fail(error: SplitchSdkError, cause?: unknown): void {
    loudly(this.deps.logger, this.deps.context.targetingKey, error, cause);
    this.deps.onFailure();
  }
}
