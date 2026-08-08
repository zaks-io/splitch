import type { ErrorCode } from "@splitch/contracts";
import {
  ExposureRedemptionClaimHttpError,
  ExposureRedemptionClaimProtocolError,
  ExposureRedemptionClaimTransportError,
} from "./exposure-redemption-claim-errors";

/**
 * Map a thrown claim-store fault to the per-item Exposure rejection code.
 *
 * Transient (SDK retries):
 * - Durable Object transport failure (stub fetch threw)
 * - Durable Object non-400 HTTP (e.g. 500 — reachable; see exposure-redemption-do.test.ts)
 *
 * Deterministic (SDK drops):
 * - Durable Object HTTP 400
 * - parseClaimOutcome protocol violation
 * - TypeError / any unclassified throw (fail loud; never quietly retryable)
 *
 * docs/spec/sdk/exposures-endpoint.md
 */
const DETERMINISTIC_CLAIM_HTTP_STATUSES = new Set([400]);

export function exposureClaimFaultCode(cause: unknown): ErrorCode {
  if (cause instanceof ExposureRedemptionClaimTransportError) {
    return "SERVICE_UNAVAILABLE";
  }
  if (cause instanceof ExposureRedemptionClaimHttpError) {
    if (DETERMINISTIC_CLAIM_HTTP_STATUSES.has(cause.status)) {
      return "INTERNAL_SERVER_ERROR";
    }
    return "SERVICE_UNAVAILABLE";
  }
  if (cause instanceof ExposureRedemptionClaimProtocolError) {
    return "INTERNAL_SERVER_ERROR";
  }
  return "INTERNAL_SERVER_ERROR";
}
