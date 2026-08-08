import type { ErrorCode } from "./generated/contract-surface.js";

/**
 * Per-item Exposure rejection codes the browser queue must re-queue.
 * Lockstep with `@splitch/contracts` `RETRYABLE_EXPOSURE_REJECTION_CODES`
 * (exposures-endpoint.md). Proven by `exposure-retry.parity.test.ts`.
 */
export const RETRYABLE_EXPOSURE_REJECTION_CODES = [
  "SERVICE_UNAVAILABLE",
] as const satisfies readonly ErrorCode[];

const retryable = new Set<string>(RETRYABLE_EXPOSURE_REJECTION_CODES);

/** True when a per-item `rejected` code should be retained for another flush. */
export function isRetryableExposureRejection(code: ErrorCode | string | null): boolean {
  return code !== null && retryable.has(code);
}

export interface ExposureAckItem {
  readonly exposureId: string;
}

export interface ExposureAckResult {
  readonly exposureId: string;
  readonly status: "accepted" | "deduplicated" | "rejected";
  readonly code: ErrorCode | string | null;
}

/**
 * Partition a sent batch against its per-item results.
 * Accepted/deduplicated/non-retryable-rejected → completed (dropped from queue).
 * Missing rows and retryable rejections → retained for the next flush.
 */
export function partitionExposureBatchResults<T extends ExposureAckItem>(
  batch: readonly T[],
  results: readonly ExposureAckResult[],
): { completed: ExposureAckResult[]; retained: T[] } {
  const byId = new Map(results.map((row) => [row.exposureId, row]));
  const retained: T[] = [];
  const completed: ExposureAckResult[] = [];
  for (const item of batch) {
    const row = byId.get(item.exposureId);
    if (row === undefined) {
      retained.push(item);
      continue;
    }
    if (row.status === "rejected" && isRetryableExposureRejection(row.code)) {
      retained.push(item);
      continue;
    }
    completed.push(row);
  }
  return { completed, retained };
}
