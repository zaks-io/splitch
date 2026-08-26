import type { ErrorResponse } from "@splitch/sdk/control-plane";

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
    io.error(
      `Approval Request ${request.id} is stale and was not applied: ${review.error.code}${detailSuffix(review.error.details)}. Re-propose against the current state.`,
    );
  }
}

function detailSuffix(details: Record<string, unknown>): string {
  if (
    Array.isArray(details.frozenFields) &&
    details.frozenFields.every((field) => typeof field === "string")
  ) {
    return ` (frozenFields: ${details.frozenFields.join(", ")})`;
  }
  // Map internal fault slugs to operator prose; never print the slug itself.
  if (details.fault === "approval_changed_fields_undetermined") {
    return " (changed-field set could not be determined)";
  }
  if (details.fault === "approval_empty_change") {
    return " (no Flag Configuration field to apply)";
  }
  return "";
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

/**
 * Louder remediation when the API refusal already names frozen fields.
 *
 * `commandSupportsConfirm` must be the invoking command's own
 * `CliCommandDefinition.supportsConfirm` (see command-registry.ts): only 5 of
 * the 9 operations that can answer APPROVAL_REVIEW_REQUIRED wire --confirm at
 * all, so the copy must not invite a retry the command can never honor.
 */
export function remediationForServerError(
  error: ErrorResponse,
  commandSupportsConfirm: boolean,
): string {
  const frozen = runFrozenRemediation(error);
  if (frozen) return frozen;
  if (error.code === "APPROVAL_REQUEST_STALE") {
    return "Refresh the target and re-propose; a stale Approval Request cannot be applied";
  }
  const reviewRequired = approvalReviewRequiredRemediation(error, commandSupportsConfirm);
  if (reviewRequired) return reviewRequired;
  const undetermined = undeterminedChangeRemediation(error);
  if (undetermined) return undetermined;
  return "Correct the reported API failure and retry the command";
}

const CONFIRM_HINT = "rerun the same command with --confirm if you hold approver rights";

function approvalReviewRequiredRemediation(
  error: ErrorResponse,
  commandSupportsConfirm: boolean,
): string | null {
  if (error.code !== "APPROVAL_REVIEW_REQUIRED") return null;
  const requestId =
    "approvalRequestId" in error.details && typeof error.details.approvalRequestId === "string"
      ? error.details.approvalRequestId
      : null;
  if (!requestId) {
    // The request id may be missing from a malformed response; only add the
    // --confirm hint when this command actually wires the flag.
    return commandSupportsConfirm ? `Correct the reported API failure, or ${CONFIRM_HINT}` : null;
  }
  const reviewClause = `Review Approval Request ${requestId} (splitch approval-requests get ${requestId})`;
  return commandSupportsConfirm ? `${reviewClause}, or ${CONFIRM_HINT}` : reviewClause;
}

function runFrozenRemediation(error: ErrorResponse): string | null {
  if (error.code !== "RUN_FROZEN" || !("frozenFields" in error.details)) return null;
  const fields = error.details.frozenFields;
  const action =
    "recommendedAction" in error.details && typeof error.details.recommendedAction === "string"
      ? error.details.recommendedAction
      : "END_RUNNING_RUN_FIRST";
  return `End the running Run first (${action}); frozen fields: ${Array.isArray(fields) ? fields.join(", ") : "unknown"}`;
}

function undeterminedChangeRemediation(error: ErrorResponse): string | null {
  if (error.code !== "INTERNAL_SERVER_ERROR" || !("fault" in error.details)) return null;
  if (error.details.fault === "approval_empty_change") {
    return "Re-propose the change; this Approval Request does not change any Flag Configuration field that can be applied";
  }
  if (error.details.fault === "approval_changed_fields_undetermined") {
    return "Re-propose the change; this Approval Request's changed-field set cannot be determined and will not apply";
  }
  return null;
}
