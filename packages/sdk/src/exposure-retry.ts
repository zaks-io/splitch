import type { ErrorCode } from "./generated/contract-surface.js";
import { ErrorCodeSchema } from "./generated/contract-surface.js";

/**
 * Sole transient per-item Exposure rejection code(s). Derived from the server
 * contract (`@splitch/contracts` `RETRYABLE_EXPOSURE_REJECTION_CODES` /
 * docs/spec/sdk/exposures-endpoint.md) — not a free-floating literal.
 *
 * The browser Exposure queue is the shipping consumer. This stays internal to
 * the package rather than becoming a public SDK export.
 */
export const RETRYABLE_EXPOSURE_REJECTION_CODES = [
  "SERVICE_UNAVAILABLE",
] as const satisfies readonly ErrorCode[];

export function isRetryableExposureRejection(code: ErrorCode): boolean {
  return (RETRYABLE_EXPOSURE_REJECTION_CODES as readonly ErrorCode[]).includes(code);
}

const EXPOSURE_RESULT_STATUSES = new Set(["accepted", "deduplicated", "rejected"]);

type ExposureResultRow = {
  readonly exposureId: string;
  readonly status: string;
  readonly code: string | null;
};

function assertKnownResultStatus(row: ExposureResultRow): void {
  if (!EXPOSURE_RESULT_STATUSES.has(row.status)) {
    throw new Error(
      `Unrecognized Exposure batch result status for ${row.exposureId}: ${JSON.stringify(row.status)}`,
    );
  }
}

/** Fail loud on rejected+null / unknown code; return whether the item stays queued. */
function shouldRetainRejected(row: ExposureResultRow): boolean {
  if (row.code === null) {
    throw new Error(
      `Exposure rejection for ${row.exposureId} is missing a code (fail loud; never silently drop)`,
    );
  }
  const parsed = ErrorCodeSchema.safeParse(row.code);
  if (!parsed.success) {
    throw new Error(
      `Unrecognized Exposure rejection code for ${row.exposureId}: ${JSON.stringify(row.code)}`,
    );
  }
  return isRetryableExposureRejection(parsed.data);
}

/**
 * Apply one flush's per-item results to a pending queue: accepted, deduplicated,
 * and non-retryable rejections leave the queue; retryable rejections and missing
 * rows are retained with the same exposureId.
 *
 * Unrecognized status or rejection code throws (ADR-0036) — never silently drop.
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
    assertKnownResultStatus(row);
    if (row.status === "rejected" && shouldRetainRejected(row)) {
      retained.push(item);
    }
  }
  return retained;
}
