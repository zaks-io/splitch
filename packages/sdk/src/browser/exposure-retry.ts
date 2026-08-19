import { formatSdkErrorMessage } from "../errors";
import type { Logger } from "../evaluate";
import {
  EXPOSURE_BATCH_FAILURE_NO_RETRY_REMEDIATION,
  EXPOSURE_BATCH_FAILURE_RETRY_REMEDIATION,
  EXPOSURE_BATCH_FAILURE_TERMINAL_REMEDIATION,
} from "./exposure-drain";
import type { BrowserTransportFailure } from "./http";

const MAX_DELIVERY_ATTEMPTS = 3;
const RETRYABLE_CLIENT_STATUSES = new Set([408, 425, 429]);

function isNonRetryableStatus(status: number | null): boolean {
  return status !== null && status >= 400 && status < 500 && !RETRYABLE_CLIENT_STATUSES.has(status);
}

export class ExposureRetryPolicy {
  private attemptCount = 0;
  private stopped = false;

  constructor(private readonly logger: Logger) {}

  get automaticRetryAllowed(): boolean {
    return !this.stopped;
  }

  recordFailure(result: BrowserTransportFailure, count: number): boolean {
    if (this.stopped) {
      return false;
    }
    this.attemptCount += 1;
    const nonRetryable = isNonRetryableStatus(result.status);
    if (!nonRetryable && this.attemptCount < MAX_DELIVERY_ATTEMPTS) {
      return true;
    }
    this.stopped = true;
    const causeSummary = nonRetryable
      ? `Exposure delivery stopped after non-retryable HTTP ${result.status}`
      : `Exposure delivery stopped after ${this.attemptCount} failed attempts`;
    this.logger.error(
      formatSdkErrorMessage({
        code: result.errorCode ?? "SERVICE_UNAVAILABLE",
        causeSummary,
        remediation:
          "Correct the delivery failure, then call flush() explicitly; automatic retries are disabled for this queue",
        status: result.status,
      }),
      {
        status: result.status,
        errorCode: result.errorCode ?? "SERVICE_UNAVAILABLE",
        count,
        attemptCount: this.attemptCount,
        automaticRetryStopped: true,
      },
    );
    return false;
  }

  remediationForFailure(result: BrowserTransportFailure, count: number, closed: boolean): string {
    if (closed) {
      return EXPOSURE_BATCH_FAILURE_NO_RETRY_REMEDIATION;
    }
    if (!this.recordFailure(result, count)) {
      return EXPOSURE_BATCH_FAILURE_TERMINAL_REMEDIATION;
    }
    return EXPOSURE_BATCH_FAILURE_RETRY_REMEDIATION;
  }

  recordSuccess(): void {
    this.attemptCount = 0;
    this.stopped = false;
  }
}
