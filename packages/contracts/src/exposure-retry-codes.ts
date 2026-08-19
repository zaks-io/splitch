import type { ErrorCode } from "./error-code";

/**
 * Sole transient per-item Exposure batch rejection code.
 * Must stay aligned with docs/spec/sdk/exposures-endpoint.md (Redemption
 * semantics). RATE_LIMITED is a batch-level gate, not an item outcome.
 */
export const RETRYABLE_EXPOSURE_REJECTION_CODE = "SERVICE_UNAVAILABLE" as const satisfies ErrorCode;

/** Named set derived from {@link RETRYABLE_EXPOSURE_REJECTION_CODE} — not a second list. */
export const RETRYABLE_EXPOSURE_REJECTION_CODES = [RETRYABLE_EXPOSURE_REJECTION_CODE] as const;
