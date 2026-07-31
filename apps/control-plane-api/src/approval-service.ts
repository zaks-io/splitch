import {
  ApprovalDiffSchema,
  type ApprovalOperation,
  type ApprovalPolicyContext,
  ApprovalPolicyContextSchema,
  type ApprovalTarget,
} from "@splitch/contracts";
import { appScope } from "@splitch/db";
import type { Principal } from "@splitch/worker-runtime";
import { requireAppAdmin } from "./app-authz";
import {
  approvalDiff,
  approvalRequestId,
  approvalReviewId,
  canonicalHash,
  canonicalJson,
} from "./approval-canonical";
import { approvalRequestProjection } from "./approval-model";
import { prepareAndApplyApproval } from "./approval-review-application";
import {
  approvalNotFound,
  idempotencyConflict,
  materializeStale,
  projectedResult,
  requiredAuthDoor,
  resolvedError,
  resolvedWinner,
  reviewForbidden,
  reviewRequired,
} from "./approval-review-outcomes";
import { replayResult, staleReplay } from "./approval-review-replay";
import { rowTargetVersion } from "./approval-row-target";
import type {
  ApprovalRequestRow,
  ApprovalResult,
  ApprovalServiceDeps,
  ReviewApprovalInput,
} from "./approval-service-types";
import { approvalTargetVersion, currentPolicyProjection } from "./approval-target";

export interface CreateApprovalInput {
  appId: string;
  operation: ApprovalOperation;
  target: Omit<ApprovalTarget, "version">;
  policyContexts: ApprovalPolicyContext[];
  current: Record<string, unknown>;
  proposed: Record<string, unknown>;
  proposalInput: Record<string, unknown>;
  principal: Principal;
  idempotencyKey: string;
  inlineReview: boolean;
  requestId: string;
  /** Set only when the target does not exist yet (a Variant create proposal). */
  absentVariant?: { flagId: string; name: string };
}

type ReplayApprovalInput = Pick<
  CreateApprovalInput,
  | "appId"
  | "operation"
  | "target"
  | "proposalInput"
  | "principal"
  | "idempotencyKey"
  | "inlineReview"
  | "requestId"
>;

export async function replayApprovalIfExists(
  deps: ApprovalServiceDeps,
  input: ReplayApprovalInput,
  options: { ignoreMismatch?: boolean } = {},
): Promise<ApprovalResult | null> {
  const row = await deps.repo.approvals.getRequestByActorKey(
    appScope(input.appId),
    input.principal.id,
    input.idempotencyKey,
  );
  if (!row) return null;
  const requestHash = await proposalRequestHash(input);
  if (row.requestHash !== requestHash) {
    if (options.ignoreMismatch) return null;
    return {
      ok: false,
      response: idempotencyConflict("approval_request", input.idempotencyKey, input.requestId),
    };
  }
  if (input.inlineReview) {
    return reviewApproval(deps, {
      appId: input.appId,
      approvalRequestId: row.id,
      action: "approve_and_apply",
      reason: null,
      idempotencyKey: input.idempotencyKey,
      principal: input.principal,
      requestId: input.requestId,
    });
  }
  return replayOutcome(deps, row, input.requestId);
}

/**
 * Only an APPLIED replay is a successful write. A `declined` or `stale` request
 * changed nothing, so answering `ok` would let the caller read the live resource
 * and report a change that never happened as the result of this call.
 */
async function replayOutcome(
  deps: ApprovalServiceDeps,
  row: ApprovalRequestRow,
  requestId: string,
): Promise<ApprovalResult> {
  const request = await approvalRequestProjection(deps.repo, row);
  if (request.status === "applied") return { ok: true, approvalRequest: request };
  if (request.status === "pending") {
    return { ok: false, response: reviewRequired(request, requestId) };
  }
  // A derived `stale` status sits on a still-`pending` row, which the resolved
  // error cannot describe: its `status` detail admits only terminal values.
  if (row.status === "pending") return staleReplay(deps, row, requestId);
  return { ok: false, response: await resolvedError(deps, row, requestId) };
}

export async function createApproval(
  deps: ApprovalServiceDeps,
  input: CreateApprovalInput,
): Promise<ApprovalResult> {
  const replay = await replayApprovalIfExists(deps, input);
  if (replay) return replay;
  const targetVersion = await approvalTargetVersion(
    deps.repo,
    input.appId,
    input.target,
    input.policyContexts,
    input.absentVariant ? { absentVariant: input.absentVariant } : undefined,
  );
  const diff = ApprovalDiffSchema.parse(approvalDiff(input.current, input.proposed));
  const requestHash = await proposalRequestHash(input);
  const now = deps.nowIso?.() ?? new Date().toISOString();
  const created = await deps.repo.approvals.createRequest(appScope(input.appId), {
    id: approvalRequestId(new Date(now).getTime()),
    operation: input.operation,
    targetType: input.target.type,
    targetId: input.target.id,
    targetVersion,
    policyContexts: JSON.stringify(input.policyContexts),
    diff: canonicalJson(diff),
    status: "pending",
    proposedBy: input.principal.id,
    proposedVia: requiredAuthDoor(input.principal),
    proposedAt: now,
    resolvedAt: null,
    resultingTargetVersion: null,
    resultingResourceType: null,
    resultingResourceId: null,
    idempotencyKey: input.idempotencyKey,
    requestHash,
  });
  if (!created.ok) {
    return {
      ok: false,
      response: idempotencyConflict("approval_request", input.idempotencyKey, input.requestId),
    };
  }
  const request = await approvalRequestProjection(deps.repo, created.request);
  if (!input.inlineReview) {
    return { ok: false, response: reviewRequired(request, input.requestId) };
  }
  return reviewApproval(deps, {
    appId: input.appId,
    approvalRequestId: request.id,
    action: "approve_and_apply",
    reason: null,
    idempotencyKey: input.idempotencyKey,
    principal: input.principal,
    requestId: input.requestId,
  });
}

function proposalRequestHash(input: ReplayApprovalInput) {
  return canonicalHash({
    operation: input.operation,
    target: input.target,
    proposalInput: input.proposalInput,
  });
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: authorization, idempotency, and version checks must remain in this fail-fast order
export async function reviewApproval(
  deps: ApprovalServiceDeps,
  input: ReviewApprovalInput,
): Promise<ApprovalResult> {
  const scope = appScope(input.appId);
  const row = await deps.repo.approvals.getRequest(scope, input.approvalRequestId);
  if (!row) return { ok: false, response: approvalNotFound(input.requestId) };

  const requestHash = await canonicalHash({ action: input.action, reason: input.reason });
  const replay = await deps.repo.approvals.reviewByActorKey(
    scope,
    row.id,
    input.principal.id,
    input.idempotencyKey,
  );
  if (replay) {
    return replay.requestHash === requestHash
      ? replayResult(deps, row, replay, input.requestId)
      : {
          ok: false,
          response: idempotencyConflict("review", input.idempotencyKey, input.requestId),
        };
  }
  if (row.status !== "pending") {
    return { ok: false, response: await resolvedError(deps, row, input.requestId) };
  }

  const roleError = await requireAppAdmin(deps, input.appId, input.principal, input.requestId);
  if (roleError) {
    return {
      ok: false,
      response: reviewForbidden(row.id, input.action, "ROLE_NOT_ALLOWED", input.requestId),
    };
  }
  const contexts = ApprovalPolicyContextSchema.array().parse(JSON.parse(row.policyContexts));
  const now = deps.nowIso?.() ?? new Date().toISOString();
  // Declining never touches the target, so it neither needs nor re-validates the
  // target version: a proposal against a deleted target must still be closable.
  if (input.action === "decline") {
    const resolved = await deps.repo.approvals.resolveWithoutApplication(scope, {
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

  const policyError = await validateReviewPolicy(deps, row.proposedBy, contexts, input);
  if (policyError) return policyError;

  const currentVersion = await rowTargetVersion(deps.repo, row, contexts, row.diff);
  if (currentVersion !== row.targetVersion) {
    return materializeStale(deps, row, input, requestHash, currentVersion);
  }

  return prepareAndApplyApproval(deps, row, input, requestHash, now, contexts);
}

async function validateReviewPolicy(
  deps: ApprovalServiceDeps,
  proposedBy: string,
  contexts: ApprovalPolicyContext[],
  input: ReviewApprovalInput,
): Promise<ApprovalResult | null> {
  const currentPolicy = await currentPolicyProjection(deps.repo, input.appId, contexts);
  if (
    input.principal.id === proposedBy &&
    currentPolicy.some((context) => context.level === "approve")
  ) {
    return {
      ok: false,
      response: reviewForbidden(
        input.approvalRequestId,
        input.action,
        "SELF_REVIEW_NOT_ALLOWED",
        input.requestId,
      ),
    };
  }
  return null;
}

export type { ApprovalServiceDeps } from "./approval-service-types";
