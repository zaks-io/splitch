import { ApprovalPolicyContextSchema, ErrorCodeSchema } from "@splitch/contracts";
import { renderError } from "@splitch/worker-runtime";
import { applicationFailureMessage, projectedResult } from "./approval-review-outcomes";
import { rowTargetVersion } from "./approval-row-target";
import type {
  ApplicationTargetState,
  ApprovalRequestRow,
  ApprovalResult,
  ApprovalReviewRow,
  ApprovalServiceDeps,
} from "./approval-service-types";

/**
 * What an exact-key retry of a Review gets back. The replay has to answer with
 * the SAME refusal the first call did, or an operator retrying a request they
 * never saw the response to would be told a different story about what happened.
 */
export async function replayResult(
  deps: ApprovalServiceDeps,
  row: ApprovalRequestRow,
  review: ApprovalReviewRow,
  requestId: string,
): Promise<ApprovalResult> {
  if (review.outcome === "failed") {
    // The Review row records the cause, never what the attempt left behind in
    // the target, so the replay cannot repeat the original claim. Asserting
    // either "rolled back" or "applied" from a row that does not say would be
    // the plausible wrong value ADR-0036 forbids, so the replay says `unknown`
    // and sends the operator to the Approval Request that does know.
    return failedReplay(row, review, "unknown", requestId);
  }
  if (review.outcome === "stale") {
    // A `stale` Review means one of two different things. Only the version race
    // has no recorded cause, and only it should be answered as one.
    return review.errorCode
      ? recordedRefusalReplay(review, requestId)
      : staleReplay(deps, row, requestId);
  }
  return projectedResult(deps, row.appId, row.id, requestId);
}

/**
 * Replay a Review that was refused for a reason the Worker wrote down, as that
 * reason. The recorded `code` and `details` are the whole point — they carry the
 * frozen fields, the Run, and an action the operator can actually take. The
 * message is deliberately generic because the row stores the cause, not prose.
 */
function recordedRefusalReplay(review: ApprovalReviewRow, requestId: string): ApprovalResult {
  return {
    ok: false,
    response: renderError(
      {
        code: ErrorCodeSchema.parse(review.errorCode),
        message: "Approval Request was refused when it was reviewed and cannot be applied",
        details: review.errorDetails ? JSON.parse(review.errorDetails) : {},
      } as Parameters<typeof renderError>[0],
      { requestId },
    ),
  };
}

function failedReplay(
  row: ApprovalRequestRow,
  review: ApprovalReviewRow,
  targetState: ApplicationTargetState,
  requestId: string,
): ApprovalResult {
  return {
    ok: false,
    response: renderError(
      {
        code: "APPROVAL_APPLICATION_FAILED",
        message: applicationFailureMessage(targetState),
        details: {
          approvalRequestId: row.id,
          reviewId: review.id,
          applicationError: {
            code: ErrorCodeSchema.parse(review.errorCode),
            details: review.errorDetails ? JSON.parse(review.errorDetails) : {},
          },
          recommendedAction: "RETRY_REVIEW",
        },
      },
      { requestId },
    ),
  };
}

export async function staleReplay(
  deps: ApprovalServiceDeps,
  row: ApprovalRequestRow,
  requestId: string,
): Promise<ApprovalResult> {
  const contexts = ApprovalPolicyContextSchema.array().parse(JSON.parse(row.policyContexts));
  const currentVersion = await rowTargetVersion(deps.repo, row, contexts, row.diff);
  return {
    ok: false,
    response: renderError(
      {
        code: "APPROVAL_REQUEST_STALE",
        message: "Approval Request target changed before Review",
        details: {
          approvalRequestId: row.id,
          targetVersion: row.targetVersion,
          currentTargetVersion: currentVersion,
          recommendedAction: "REFRESH_AND_REPROPOSE",
        },
      },
      { requestId },
    ),
  };
}
