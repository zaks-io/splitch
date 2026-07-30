import {
  ApprovalDiffSchema,
  ApprovalPolicyContextSchema,
  type ApprovalRequest,
  ApprovalRequestSchema,
  ApprovalRequestStatusSchema,
  type ApprovalReview,
  ApprovalReviewSchema,
  ApprovalTargetTypeSchema,
} from "@splitch/contracts";
import { appScope, type Repository } from "@splitch/db";
import { approvalTargetVersion } from "./approval-target";

type RequestRow = NonNullable<Awaited<ReturnType<Repository["approvals"]["getRequest"]>>>;
type ReviewRow = NonNullable<Awaited<ReturnType<Repository["approvals"]["latestReview"]>>>;

export async function approvalRequestProjection(
  repo: Repository,
  row: RequestRow,
): Promise<ApprovalRequest> {
  const scope = appScope(row.appId);
  const latest = await repo.approvals.latestReview(scope, row.id);
  const contexts = ApprovalPolicyContextSchema.array().parse(JSON.parse(row.policyContexts));
  const storedStatus = ApprovalRequestStatusSchema.parse(row.status);
  const currentVersion =
    storedStatus === "pending"
      ? await approvalTargetVersion(
          repo,
          row.appId,
          { type: ApprovalTargetTypeSchema.parse(row.targetType), id: row.targetId },
          contexts,
        )
      : row.targetVersion;
  const status =
    storedStatus === "pending" && currentVersion !== null && currentVersion !== row.targetVersion
      ? "stale"
      : storedStatus;

  return ApprovalRequestSchema.parse({
    id: row.id,
    appId: row.appId,
    policyContexts: contexts,
    operation: row.operation,
    target: {
      type: row.targetType,
      id: row.targetId,
      version: row.targetVersion,
    },
    diff: ApprovalDiffSchema.parse(JSON.parse(row.diff)),
    status,
    proposer: { userId: row.proposedBy, authDoor: row.proposedVia },
    proposedAt: row.proposedAt,
    resolvedAt: row.resolvedAt,
    applicationResult:
      row.status === "applied"
        ? {
            targetVersion: row.resultingTargetVersion,
            resourceType: row.resultingResourceType,
            resourceId: row.resultingResourceId,
            appliedAt: row.resolvedAt,
          }
        : null,
    latestReview: latest ? approvalReviewProjection(latest) : null,
  });
}

function approvalReviewProjection(row: ReviewRow): ApprovalReview {
  return ApprovalReviewSchema.parse({
    id: row.id,
    approvalRequestId: row.approvalRequestId,
    action: row.action,
    outcome: row.outcome,
    actor: { userId: row.reviewedBy, authDoor: row.reviewedVia },
    reviewedAt: row.reviewedAt,
    reason: row.reason,
    idempotencyKey: row.idempotencyKey,
    resultingTargetVersion: row.resultingTargetVersion,
    error:
      row.outcome === "failed"
        ? {
            code: row.errorCode,
            details: row.errorDetails ? JSON.parse(row.errorDetails) : {},
          }
        : null,
  });
}
