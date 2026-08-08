import type { ErrorCode } from "@splitch/contracts";
import {
  ExposureRedemptionClaimHttpError,
  ExposureRedemptionClaimProtocolError,
  ExposureRedemptionClaimTransportError,
} from "./exposure-redemption-claim-errors";

/**
 * Map a thrown claim-store fault to the per-item Exposure rejection code.
 *
 * Transient (SDK retries): Durable Object transport failure → SERVICE_UNAVAILABLE.
 * Deterministic (SDK drops): protocol violation, DO HTTP 400, TypeError, and any
 * unclassified throw → INTERNAL_SERVER_ERROR (fail loud; never quietly retryable).
 *
 * docs/spec/sdk/exposures-endpoint.md
 */
export function exposureClaimFaultCode(cause: unknown): ErrorCode {
  if (cause instanceof ExposureRedemptionClaimTransportError) {
    return "SERVICE_UNAVAILABLE";
  }
  if (
    cause instanceof ExposureRedemptionClaimHttpError ||
    cause instanceof ExposureRedemptionClaimProtocolError
  ) {
    return "INTERNAL_SERVER_ERROR";
  }
  // TypeError and every unclassified throw: fail loud as non-retryable.
  return "INTERNAL_SERVER_ERROR";
}
