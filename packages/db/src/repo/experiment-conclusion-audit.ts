import { auditStatement } from "./audit-event-write";
import type {
  CommitConclusionInput,
  CreateReplacementPromotionInput,
} from "./experiment-conclusion-atomic";
import type { EnvScope, TenantScope } from "./scope";

export function conclusionAuditStatements(
  d1: D1Database,
  scope: EnvScope,
  input: CommitConclusionInput,
) {
  const c = input.conclusion;
  return [
    auditStatement(d1, scope, {
      actorRef: c.concludedBy,
      actorVia: c.concludedVia,
      requestId: input.audit?.requestId ?? null,
      changedAt: c.concludedAt,
      action: "runs_conclude",
      resourceType: "run",
      resourceId: c.runId,
      environmentId: scope.environmentId,
      targetVersion: c.configHash,
      runId: c.runId,
      approvalRequestId: input.approval.id,
    }),
    auditStatement(d1, scope, {
      actorRef: input.approval.proposedBy,
      actorVia: input.approval.proposedVia,
      requestId: input.audit?.requestId ?? null,
      changedAt: input.approval.proposedAt,
      action: "runs_conclude",
      resourceType: "approval_request",
      resourceId: input.approval.id,
      environmentId: c.targetEnvironmentId,
      targetVersion: input.approval.targetVersion,
      outcome: "pending",
      approvalRequestId: input.approval.id,
      runId: c.runId,
    }),
  ];
}

export function replacementAuditStatement(
  d1: D1Database,
  scope: TenantScope,
  input: CreateReplacementPromotionInput,
) {
  return auditStatement(d1, scope, {
    actorRef: input.approval.proposedBy,
    actorVia: input.approval.proposedVia,
    requestId: input.audit?.requestId ?? null,
    changedAt: input.createdAt,
    action: "conclusion_promotion_requests_create",
    resourceType: "approval_request",
    resourceId: input.approval.id,
    environmentId: input.targetEnvironmentId,
    targetVersion: input.approval.targetVersion,
    outcome: "pending",
    approvalRequestId: input.approval.id,
    runId: input.runId ?? null,
  });
}
