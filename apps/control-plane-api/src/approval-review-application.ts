import {
  type ApprovalOperation,
  ApprovalOperationSchema,
  type ApprovalPolicyContext,
  ApprovalPolicyContextSchema,
  type ApprovalRequest,
} from "@splitch/contracts";
import { type ApprovalCommit, appScope } from "@splitch/db";
import { requireAppAdmin } from "./app-authz";
import { approvalReviewId } from "./approval-canonical";
import { approvalRequestProjection } from "./approval-model";
import { isFlagConfigurationOperation, resultingVersionFor } from "./approval-resulting-version";
import {
  approvalNotFound,
  materializeStale,
  projectedResult,
  recordApplicationFailure,
  requiredAuthDoor,
  resolvedError,
  reviewForbidden,
} from "./approval-review-outcomes";
import { rowTargetVersion } from "./approval-row-target";
import type {
  ApplicationOutcome,
  ApprovalRequestRow,
  ApprovalResult,
  ApprovalServiceDeps,
  ReviewApprovalInput,
} from "./approval-service-types";
import { currentPolicyProjection } from "./approval-target";
import type { FlagConfigResult, FlagConfigWriteResult } from "./config-store-types";

export async function prepareAndApplyApproval(
  deps: ApprovalServiceDeps,
  row: ApprovalRequestRow,
  input: ReviewApprovalInput,
  requestHash: string,
  now: string,
  contexts: ApprovalPolicyContext[],
): Promise<ApprovalResult> {
  const operation = ApprovalOperationSchema.parse(row.operation);
  const resource = resultingResource(row, operation);
  const resultingVersion = await resultingVersionFor(
    deps.repo,
    row,
    operation,
    contexts,
    resource.id,
  );
  if (!resultingVersion) {
    return { ok: false, response: approvalNotFound(input.requestId) };
  }
  const commit: ApprovalCommit = {
    requestId: row.id,
    reviewId: approvalReviewId(new Date(now).getTime()),
    action: "approve_and_apply",
    reviewedBy: input.principal.id,
    reviewedVia: requiredAuthDoor(input.principal),
    reviewedAt: now,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
    requestHash,
    resultingTargetVersion: resultingVersion,
    resultingResourceType: resource.type,
    resultingResourceId: resource.id,
    policyContexts: contexts,
  };
  return applyAndProject(deps, row, commit, input);
}

async function applyAndProject(
  deps: ApprovalServiceDeps,
  row: ApprovalRequestRow,
  commit: ApprovalCommit,
  input: ReviewApprovalInput,
): Promise<ApprovalResult> {
  try {
    const request = await approvalRequestProjection(deps.repo, row);
    const application = isFlagConfigurationOperation(request.operation)
      ? await applyFlagConfiguration(deps, request, commit)
      : await deps.applyOther?.(request, commit);
    if (!application) {
      return recordApplicationFailure(
        deps,
        row,
        commit,
        { code: "INTERNAL_SERVER_ERROR", details: {} },
        input.requestId,
      );
    }
    // A `notApplied` outcome falls through to the reconciliation below, which
    // reads the stored status and answers applied / resolved / stale.
    if (!(application.ok || "notApplied" in application)) {
      return recordApplicationFailure(deps, row, commit, application.error, input.requestId);
    }
  } catch (cause) {
    const current = await deps.repo.approvals.getRequest(appScope(row.appId), row.id);
    if (current?.status === "applied") throw cause;
    return recordApplicationFailure(
      deps,
      row,
      commit,
      { code: "INTERNAL_SERVER_ERROR", details: {} },
      input.requestId,
    );
  }

  const current = await deps.repo.approvals.getRequest(appScope(row.appId), row.id);
  if (current?.status === "applied") {
    return projectedResult(deps, row.appId, row.id, input.requestId);
  }
  if (current?.status && current.status !== "pending") {
    return { ok: false, response: await resolvedError(deps, current, input.requestId) };
  }
  return staleAfterLostApply(deps, row, commit, input);
}

async function staleAfterLostApply(
  deps: ApprovalServiceDeps,
  row: ApprovalRequestRow,
  commit: ApprovalCommit,
  input: ReviewApprovalInput,
): Promise<ApprovalResult> {
  const roleError = await requireAppAdmin(deps, row.appId, input.principal, input.requestId);
  if (roleError) {
    return {
      ok: false,
      response: reviewForbidden(row.id, input.action, "ROLE_NOT_ALLOWED", input.requestId),
    };
  }
  const contexts = ApprovalPolicyContextSchema.array().parse(JSON.parse(row.policyContexts));
  const currentPolicy = await currentPolicyProjection(deps.repo, row.appId, contexts);
  if (
    input.principal.id === row.proposedBy &&
    currentPolicy.some((context) => context.level === "approve")
  ) {
    return {
      ok: false,
      response: reviewForbidden(row.id, input.action, "SELF_REVIEW_NOT_ALLOWED", input.requestId),
    };
  }
  const currentVersion = await rowTargetVersion(deps.repo, row, contexts, row.diff);
  if (currentVersion === row.targetVersion) {
    return recordApplicationFailure(
      deps,
      row,
      commit,
      { code: "INTERNAL_SERVER_ERROR", details: {} },
      input.requestId,
    );
  }
  return materializeStale(
    deps,
    row,
    {
      ...input,
      appId: row.appId,
      approvalRequestId: row.id,
    },
    commit.requestHash,
    currentVersion,
  );
}

async function applyFlagConfiguration(
  deps: ApprovalServiceDeps,
  request: ApprovalRequest,
  commit: ApprovalCommit,
): Promise<ApplicationOutcome> {
  if (!deps.configStore) {
    return {
      ok: false as const,
      error: { code: "SERVICE_UNAVAILABLE" as const, details: { retryAfterMs: 1000 } },
    };
  }
  const environmentId = request.policyContexts[0]?.environmentId;
  const proposed = request.diff.proposed as unknown as FlagConfigResult;
  if (!environmentId) {
    return {
      ok: false as const,
      error: { code: "INTERNAL_SERVER_ERROR" as const, details: {} },
    };
  }
  const result = await deps.configStore
    .writerFor(request.appId, environmentId)
    .applyApprovedFlagConfig({
      appId: request.appId,
      environmentId,
      flagId: proposed.flagId,
      proposed,
      approval: commit,
    });
  if (result.ok) return { ok: true as const };
  return configFailure(result, proposed.flagId, environmentId);
}

function configFailure(
  result: Extract<FlagConfigWriteResult, { ok: false }>,
  flagId: string,
  environmentId: string,
): ApplicationOutcome {
  if (result.reason === "APPROVAL_NOT_APPLIED") {
    return { ok: false as const, notApplied: true as const };
  }
  if (result.reason === "VARIANT_NOT_AVAILABLE") {
    return {
      ok: false as const,
      error: {
        code: "VARIANT_NOT_AVAILABLE" as const,
        details: {
          flagId,
          environmentId,
          missingVariants: result.missingVariants,
          recommendedAction: "ADD_VARIANT_TO_ENV",
        },
      },
    };
  }
  return {
    ok: false as const,
    error: { code: "INTERNAL_SERVER_ERROR" as const, details: {} },
  };
}

function resultingResource(
  row: ApprovalRequestRow,
  operation: ApprovalOperation,
): { type: "flag" | "flag_configuration" | "flag_variant" | "experiment_run"; id: string } {
  if (isFlagConfigurationOperation(operation)) {
    return { type: "flag_configuration", id: row.targetId };
  }
  if (operation === "flags_delete") return { type: "flag", id: row.targetId };
  return operation === "experiments_start"
    ? { type: "experiment_run", id: `run_${row.id.slice(4)}` }
    : { type: "flag_variant", id: row.targetId };
}
