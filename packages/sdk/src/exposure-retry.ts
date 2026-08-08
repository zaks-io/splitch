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

/**
 * Apply one flush's per-item results to a pending queue: accepted, deduplicated,
 * and non-retryable rejections leave the queue; retryable rejections and missing
 * rows are retained with the same exposureId.
 */
export function retainRetryableExposures<T extends { readonly exposureId: string }>(
  pending: readonly T[],
  results: readonly {
    readonly exposureId: string;
    readonly status: "accepted" | "deduplicated" | "rejected";
    readonly code: ErrorCode | null;
  }[],
): T[] {
  const byId = new Map(results.map((row) => [row.exposureId, row]));
  const retained: T[] = [];
  for (const item of pending) {
    const row = byId.get(item.exposureId);
    if (row === undefined) {
      retained.push(item);
      continue;
    }
    if (
      row.status === "rejected" &&
      (row.code === null || isRetryableExposureRejection(row.code))
    ) {
      retained.push(item);
    }
  }
  return retained;
}
