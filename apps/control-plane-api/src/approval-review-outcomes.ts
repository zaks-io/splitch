import {
  ApprovalPolicyContextSchema,
  type ApprovalRequest,
  type ErrorCode,
  ErrorCodeSchema,
  ErrorDetailsSchema,
} from "@splitch/contracts";
import { type ApprovalCommit, appScope } from "@splitch/db";
import type { Principal } from "@splitch/worker-runtime";
import { renderError } from "@splitch/worker-runtime";
import { approvalReviewId } from "./approval-canonical";
import { approvalRequestProjection } from "./approval-model";
import { rowTargetVersion } from "./approval-row-target";
import type {
  ApprovalRequestRow,
  ApprovalResult,
  ApprovalReviewRow,
  ApprovalServiceDeps,
  ReviewApprovalInput,
  UnapplicableProposal,
} from "./approval-service-types";

export async function materializeStale(
  deps: ApprovalServiceDeps,
  row: ApprovalRequestRow,
  input: ReviewApprovalInput,
  requestHash: string,
  currentVersion: string,
): Promise<ApprovalResult> {
  const now = deps.nowIso?.() ?? new Date().toISOString();
  const resolved = await deps.repo.approvals.resolveWithoutApplication(appScope(row.appId), {
    requestId: row.id,
    reviewId: approvalReviewId(new Date(now).getTime()),
    action: input.action,
    outcome: "stale",
    reviewedBy: input.principal.id,
    reviewedVia: requiredAuthDoor(input.principal),
    reviewedAt: now,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
    requestHash,
  });
  if (!resolved) return resolvedWinner(deps, row.appId, row.id, input.requestId);
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
      { requestId: input.requestId },
    ),
  };
}

/**
 * Resolve a Request that can never apply as proposed, and say why.
 *
 * `stale` is the disposition because that is exactly what happened: the proposal
 * still describes a world that no longer exists, and the operator's move is to
 * re-propose against the state they can actually see. It is NOT recorded as a
 * retryable application failure — that would leave the Request pending and
 * approvable the instant the blocking condition lifted, which is the silent
 * delayed write the refusal exists to prevent.
 */
export async function resolveUnapplicable(
  deps: ApprovalServiceDeps,
  row: ApprovalRequestRow,
  commit: ApprovalCommit,
  requestId: string,
  refusal: UnapplicableProposal,
): Promise<ApprovalResult> {
  const resolved = await deps.repo.approvals.resolveWithoutApplication(appScope(row.appId), {
    requestId: row.id,
    reviewId: commit.reviewId,
    action: "approve_and_apply",
    outcome: "stale",
    reviewedBy: commit.reviewedBy,
    reviewedVia: commit.reviewedVia,
    reviewedAt: commit.reviewedAt,
    reason: commit.reason,
    idempotencyKey: commit.idempotencyKey,
    requestHash: commit.requestHash,
  });
  if (!resolved) return resolvedWinner(deps, row.appId, row.id, requestId);
  return {
    ok: false,
    response: renderError(
      {
        code: refusal.code,
        message: refusal.message,
        details: refusal.details,
      } as Parameters<typeof renderError>[0],
      { requestId },
    ),
  };
}

export async function recordApplicationFailure(
  deps: ApprovalServiceDeps,
  row: ApprovalRequestRow,
  commit: ApprovalCommit,
  error: { code: ErrorCode; details: Record<string, unknown> },
  requestId: string,
): Promise<ApprovalResult> {
  const code = ErrorCodeSchema.parse(error.code);
  const errorDetails = ErrorDetailsSchema.parse(error.details);
  const recorded = await deps.repo.approvals.recordFailure(appScope(row.appId), {
    requestId: row.id,
    reviewId: commit.reviewId,
    reviewedBy: commit.reviewedBy,
    reviewedVia: commit.reviewedVia,
    reviewedAt: commit.reviewedAt,
    reason: commit.reason,
    idempotencyKey: commit.idempotencyKey,
    requestHash: commit.requestHash,
    errorCode: code,
    errorDetails: JSON.stringify(errorDetails),
  });
  if (!recorded) return resolvedWinner(deps, row.appId, row.id, requestId);
  return {
    ok: false,
    response: renderError(
      {
        code: "APPROVAL_APPLICATION_FAILED",
        message: "Approval Request application failed and was rolled back",
        details: {
          approvalRequestId: row.id,
          reviewId: commit.reviewId,
          applicationError: { code, details: errorDetails },
          recommendedAction: "RETRY_REVIEW",
        },
      },
      { requestId },
    ),
  };
}

export async function replayResult(
  deps: ApprovalServiceDeps,
  row: ApprovalRequestRow,
  review: ApprovalReviewRow,
  requestId: string,
): Promise<ApprovalResult> {
  if (review.outcome === "failed") {
    return failedReplay(row, review, requestId);
  }
  if (review.outcome === "stale") {
    return staleReplay(deps, row, requestId);
  }
  return projectedResult(deps, row.appId, row.id, requestId);
}

function failedReplay(
  row: ApprovalRequestRow,
  review: ApprovalReviewRow,
  requestId: string,
): ApprovalResult {
  return {
    ok: false,
    response: renderError(
      {
        code: "APPROVAL_APPLICATION_FAILED",
        message: "Approval Request application failed and was rolled back",
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

export async function projectedResult(
  deps: ApprovalServiceDeps,
  appId: string,
  requestId: string,
  httpRequestId: string,
): Promise<ApprovalResult> {
  const row = await deps.repo.approvals.getRequest(appScope(appId), requestId);
  return row
    ? { ok: true, approvalRequest: await approvalRequestProjection(deps.repo, row) }
    : { ok: false, response: approvalNotFound(httpRequestId) };
}

export async function resolvedWinner(
  deps: ApprovalServiceDeps,
  appId: string,
  requestId: string,
  httpRequestId: string,
): Promise<ApprovalResult> {
  const row = await deps.repo.approvals.getRequest(appScope(appId), requestId);
  return row
    ? { ok: false, response: await resolvedError(deps, row, httpRequestId) }
    : { ok: false, response: approvalNotFound(httpRequestId) };
}

export async function resolvedError(
  deps: ApprovalServiceDeps,
  row: ApprovalRequestRow,
  requestId: string,
): Promise<Response> {
  const review = await deps.repo.approvals.latestReview(appScope(row.appId), row.id);
  return renderError(
    {
      code: "APPROVAL_REQUEST_RESOLVED",
      message: "Approval Request is already resolved",
      details: {
        approvalRequestId: row.id,
        status: row.status as "applied" | "declined" | "stale",
        reviewId: review?.id ?? null,
      },
    },
    { requestId },
  );
}

export function reviewRequired(request: ApprovalRequest, requestId: string): Response {
  return renderError(
    {
      code: "APPROVAL_REVIEW_REQUIRED",
      message: "Approval Request is pending Review",
      details: {
        approvalRequestId: request.id,
        status: "pending",
        policyContexts: request.policyContexts,
        recommendedAction: "REVIEW_APPROVAL_REQUEST",
      },
    },
    { requestId },
  );
}

export function reviewForbidden(
  approvalRequestId: string,
  action: "approve_and_apply" | "decline",
  reason: "SELF_REVIEW_NOT_ALLOWED" | "ROLE_NOT_ALLOWED",
  requestId: string,
) {
  return renderError(
    {
      code: "APPROVAL_REVIEW_FORBIDDEN",
      message: "principal may not Review this Approval Request",
      details: { approvalRequestId, action, reason },
    },
    { requestId },
  );
}

export function idempotencyConflict(
  scope: "approval_request" | "review",
  idempotencyKey: string,
  requestId: string,
) {
  return renderError(
    {
      code: "IDEMPOTENCY_KEY_CONFLICT",
      message: "idempotency key was already used for a different payload",
      details: { scope, idempotencyKey },
    },
    { requestId },
  );
}

export function approvalNotFound(requestId: string) {
  return renderError(
    {
      code: "APPROVAL_REQUEST_NOT_FOUND",
      message: "Approval Request not found",
      details: {},
    },
    { requestId },
  );
}

export function requiredAuthDoor(principal: Principal) {
  if (!principal.authDoor) throw new Error("Approval Review requires a resolved auth door");
  return principal.authDoor;
}
