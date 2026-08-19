import type { Logger } from "../evaluate";
import { type QueuedExposure, trimFailedOverflow } from "./exposure-batch";

interface AutomaticRetryPolicy {
  readonly automaticRetryAllowed: boolean;
}

export class ExposureOverflow {
  private retentionVersion = 0;

  constructor(
    private readonly pending: QueuedExposure[],
    private readonly enqueuedFlags: Set<string>,
    private readonly logger: Logger,
  ) {}

  retain(batch: readonly QueuedExposure[]): void {
    this.pending.unshift(...batch);
    this.retentionVersion += 1;
  }

  async flush(drain: () => Promise<unknown>, retryPolicy: AutomaticRetryPolicy): Promise<void> {
    const retentionVersion = this.retentionVersion;
    let failed = false;
    try {
      await drain();
    } catch {
      failed = true;
    }
    if (
      !failed &&
      retentionVersion === this.retentionVersion &&
      retryPolicy.automaticRetryAllowed
    ) {
      return;
    }
    // Keep the oldest batch for retry and loudly drop any excess, including when
    // every per-item result was retryable and the drain resolved without shrinking.
    trimFailedOverflow(this.pending, this.enqueuedFlags, this.logger);
  }
}
