import type { ErrorResponse } from "@splitch/contracts";

/**
 * An approved change that became unapplicable must not look like a quiet status
 * flip. When a stale Approval Request carries a recorded discard cause on its
 * latest Review, the CLI prints that cause on stderr so an operator who later
 * `get`s or lists the request learns why the change never landed (SPL-304).
 */
export function warnStaleApprovalDiscard(
  io: { error: (line: string) => void },
  payload: unknown,
): void {
  for (const request of approvalRequestsFromPayload(payload)) {
    if (request.status !== "stale") continue;
    const review = request.latestReview;
    if (review?.outcome !== "stale" || review.error === null) continue;
    const fields =
      Array.isArray(review.error.details.frozenFields) &&
      review.error.details.frozenFields.every((field) => typeof field === "string")
        ? ` (frozenFields: ${review.error.details.frozenFields.join(", ")})`
        : "";
    io.error(
      `Approval Request ${request.id} is stale and was not applied: ${review.error.code}${fields}. Re-propose against the current state.`,
    );
  }
}

function approvalRequestsFromPayload(payload: unknown): StaleCandidate[] {
  if (!isRecord(payload)) return [];
  if (isApprovalRequest(payload)) return [payload];
  if (Array.isArray(payload.items)) {
    return payload.items.filter(isApprovalRequest);
  }
  return [];
}

interface StaleCandidate {
  id: string;
  status: string;
  latestReview: {
    outcome: string;
    error: { code: string; details: Record<string, unknown> } | null;
  } | null;
}

function isApprovalRequest(value: unknown): value is StaleCandidate {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || typeof value.status !== "string") return false;
  if (value.latestReview === null) return true;
  if (!isRecord(value.latestReview)) return false;
  if (typeof value.latestReview.outcome !== "string") return false;
  if (value.latestReview.error === null) return true;
  if (!isRecord(value.latestReview.error)) return false;
  return (
    typeof value.latestReview.error.code === "string" && isRecord(value.latestReview.error.details)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Louder remediation when the API refusal already names frozen fields. */
export function remediationForServerError(error: ErrorResponse): string {
  if (error.code === "RUN_FROZEN" && "frozenFields" in error.details) {
    const fields = error.details.frozenFields;
    const action =
      "recommendedAction" in error.details && typeof error.details.recommendedAction === "string"
        ? error.details.recommendedAction
        : "END_RUNNING_RUN_FIRST";
    return `End the running Run first (${action}); frozen fields: ${Array.isArray(fields) ? fields.join(", ") : "unknown"}`;
  }
  if (error.code === "APPROVAL_REQUEST_STALE") {
    return "Refresh the target and re-propose; a stale Approval Request cannot be applied";
  }
  return "Correct the reported API failure and retry the command";
}
