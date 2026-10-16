import { appScope } from "@splitch/db";
import { approvalReviewId } from "./approval-canonical";
import { projectedResult, requiredAuthDoor, resolvedWinner } from "./approval-review-outcomes";
import type {
  ApprovalRequestRow,
  ApprovalResult,
  ApprovalServiceDeps,
  ReviewApprovalInput,
} from "./approval-service-types";
import { auditContext } from "./audit-context";

export async function declineApproval(
  deps: ApprovalServiceDeps,
  row: ApprovalRequestRow,
  input: ReviewApprovalInput,
  requestHash: string,
  now: string,
): Promise<ApprovalResult> {
  const resolved = await deps.repo.approvals.resolveWithoutApplication(appScope(input.appId), {
    audit: auditContext(input.principal, input.requestId, now),
    requestId: row.id,
    reviewId: approvalReviewId(new Date(now).getTime()),
    action: input.action,
    outcome: "declined",
    reviewedBy: input.principal.id,
    reviewedVia: requiredAuthDoor(input.principal),
    reviewedAt: now,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
    requestHash,
  });
  return resolved
    ? projectedResult(deps, row.appId, row.id, input.requestId)
    : resolvedWinner(deps, row.appId, row.id, input.requestId);
}
