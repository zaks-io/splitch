import type { ErrorCode } from "./generated/contract-surface.js";

/**
 * Per-item Exposure batch rejection codes the SDK may retry with the same
 * `exposureId`. Everything else is deterministic: acknowledge failed and drop.
 *
 * Must stay aligned with docs/spec/sdk/exposures-endpoint.md (Redemption
 * semantics). SERVICE_UNAVAILABLE is the sole transient per-item code;
 * RATE_LIMITED is a batch-level gate, not an item outcome.
 */
export function isRetryableExposureRejection(code: ErrorCode): boolean {
  return code === "SERVICE_UNAVAILABLE";
}

type ExposureResultRow = {
  readonly exposureId: string;
  readonly status: "accepted" | "deduplicated" | "rejected";
  readonly code: ErrorCode | null;
};

/** Fail loud on rejected+null; return whether the item stays in the queue. */
function shouldRetainRejected(row: ExposureResultRow): boolean {
  if (row.code === null) {
    throw new Error(
      `Exposure rejection for ${row.exposureId} is missing a code (fail loud; never silently drop)`,
    );
  }
  return isRetryableExposureRejection(row.code);
}

/**
 * Apply one flush's per-item results to a pending queue: accepted, deduplicated,
 * and non-retryable rejections leave the queue; retryable rejections and missing
 * rows are retained with the same exposureId.
 *
 * A `rejected` row with `code === null` is a silent substitution — refuse it.
 */
export function retainRetryableExposures<T extends { readonly exposureId: string }>(
  pending: readonly T[],
  results: readonly ExposureResultRow[],
): T[] {
  const byId = new Map(results.map((row) => [row.exposureId, row]));
  const retained: T[] = [];
  for (const item of pending) {
    const row = byId.get(item.exposureId);
    if (row === undefined) {
      retained.push(item);
      continue;
    }
    if (row.status === "rejected" && shouldRetainRejected(row)) {
      retained.push(item);
    }
  }
  return retained;
}
