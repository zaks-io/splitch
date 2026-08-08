import type { ErrorCode, ExposureBatchResult } from "@splitch/contracts";
import {
  ExposureRedemptionClaimHttpError,
  ExposureRedemptionClaimProtocolError,
  ExposureRedemptionClaimTransportError,
} from "./exposure-redemption-claim-errors";

/**
 * Map a thrown claim-store fault to the per-item Exposure rejection code.
 *
 * Transient (SDK retries):
 * - Durable Object transport failure (stub fetch threw, or body read failed)
 * - Durable Object 5xx HTTP (not in the DO handler vocabulary; platform/proxy
 *   injection only — still retryable if observed)
 *
 * Deterministic (SDK drops):
 * - Durable Object 4xx HTTP (handler emits 400 / 404 / 409)
 * - parseClaimOutcome / parseAcknowledgeOutcome / parseOk protocol violation
 * - TypeError / any unclassified throw (fail loud; never quietly retryable)
 *
 * docs/spec/sdk/exposures-endpoint.md
 */
function isDeterministicClaimHttpStatus(status: number): boolean {
  return status >= 400 && status < 500;
}

export function exposureClaimFaultCode(cause: unknown): ErrorCode {
  if (cause instanceof ExposureRedemptionClaimTransportError) {
    return "SERVICE_UNAVAILABLE";
  }
  if (cause instanceof ExposureRedemptionClaimHttpError) {
    if (isDeterministicClaimHttpStatus(cause.status)) {
      return "INTERNAL_SERVER_ERROR";
    }
    return "SERVICE_UNAVAILABLE";
  }
  if (cause instanceof ExposureRedemptionClaimProtocolError) {
    return "INTERNAL_SERVER_ERROR";
  }
  return "INTERNAL_SERVER_ERROR";
}

/**
 * Seam for every claim-store catch: classify once here so call sites cannot
 * hardcode SERVICE_UNAVAILABLE and re-open the SPL-366 retry loop.
 */
export function rejectClaimStoreFault(exposureId: string, cause: unknown): ExposureBatchResult {
  return { exposureId, status: "rejected", code: exposureClaimFaultCode(cause) };
}
