import type { ErrorCode, ExposureBatchResult } from "@splitch/contracts";
import { RETRYABLE_EXPOSURE_REJECTION_CODE } from "@splitch/contracts";
import {
  ExposureRedemptionClaimHttpError,
  ExposureRedemptionClaimProtocolError,
  ExposureRedemptionClaimTransportError,
} from "./exposure-redemption-claim-errors";

/**
 * HTTP statuses the Exposure redemption Durable Object handler actually emits
 * on refusal (exposure-redemption-do-handler.ts: 400 invalid payload, 404
 * method/path, 409 seal/ack mismatch). Everything else — including platform-
 * injected 408 / 425 / 429 and 5xx — is outside that vocabulary and transient.
 */
const DETERMINISTIC_CLAIM_HTTP_STATUSES = new Set([400, 404, 409]);

function isDeterministicClaimHttpStatus(status: number): boolean {
  return DETERMINISTIC_CLAIM_HTTP_STATUSES.has(status);
}

/**
 * Map a thrown claim-store fault to the per-item Exposure rejection code.
 *
 * Transient (SDK retries — {@link RETRYABLE_EXPOSURE_REJECTION_CODE}):
 * - Durable Object transport failure (stub fetch threw, or body-read network loss)
 * - HTTP outside the DO handler vocabulary (platform/proxy injection: 408 / 425 /
 *   429 / 5xx / 3xx, etc.)
 *
 * Deterministic (SDK drops):
 * - Durable Object HTTP 400 / 404 / 409 (handler vocabulary)
 * - parseClaimOutcome / parseAcknowledgeOutcome / parseOk protocol violation
 * - SyntaxError on a 200 body (invalid JSON — protocol, not transport)
 * - TypeError / any unclassified throw (fail loud; never quietly retryable)
 *
 * docs/spec/sdk/exposures-endpoint.md
 */
export function exposureClaimFaultCode(cause: unknown): ErrorCode {
  if (cause instanceof ExposureRedemptionClaimTransportError) {
    return RETRYABLE_EXPOSURE_REJECTION_CODE;
  }
  if (cause instanceof ExposureRedemptionClaimHttpError) {
    if (isDeterministicClaimHttpStatus(cause.status)) {
      return "INTERNAL_SERVER_ERROR";
    }
    return RETRYABLE_EXPOSURE_REJECTION_CODE;
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
