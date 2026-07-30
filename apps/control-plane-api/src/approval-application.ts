import type { ApprovalRequest, ErrorCode } from "@splitch/contracts";
import { type ApprovalCommit, appScope, envScope, type Repository } from "@splitch/db";
import type { ConfigStoreAccess } from "./config-store-do";
import { syncExperimentConfigFromD1 } from "./experiment-handler-shared";
import { json } from "./experiment-model";
import { prepareStart } from "./experiment-start";
import { resyncFlagSnapshots } from "./flag-definition-handler-utils";

interface ApprovalApplicationDeps {
  repo: Repository;
  configStore?: ConfigStoreAccess;
}

export function makeOtherApprovalApplication(deps: ApprovalApplicationDeps) {
  return async (
    request: ApprovalRequest,
    commit: ApprovalCommit,
  ): Promise<
    { ok: true } | { ok: false; error: { code: ErrorCode; details: Record<string, unknown> } }
  > => {
    if (request.operation === "flag_variants_update") {
      return applyVariant(deps, request, commit);
    }
    if (request.operation === "flag_variants_create") {
      return applyVariantCreate(deps, request, commit);
    }
    if (request.operation === "flag_variants_delete") {
      return applyVariantDelete(deps, request, commit);
    }
    if (request.operation === "experiments_start") {
      return applyExperimentStart(deps, request, commit);
    }
    return {
      ok: false,
      error: { code: "INTERNAL_SERVER_ERROR", details: {} },
    };
  };
}

async function applyExperimentStart(
  deps: ApprovalApplicationDeps,
  request: ApprovalRequest,
  commit: ApprovalCommit,
) {
  const environmentId = request.policyContexts[0]?.environmentId;
  if (!environmentId || !deps.configStore) {
    return {
      ok: false as const,
      error: { code: "SERVICE_UNAVAILABLE" as const, details: { retryAfterMs: 1000 } },
    };
  }
  const scope = envScope(request.appId, environmentId);
  const experiment = await deps.repo.experiments.getExperiment(scope, request.target.id);
  if (!experiment) {
    return {
      ok: false as const,
      error: { code: "EXPERIMENT_NOT_FOUND" as const, details: {} },
    };
  }
  const prepared = await prepareStart(deps.repo, scope, experiment, commit.reviewId);
  if (!prepared.ok) {
    const body = (await prepared.response.json()) as {
      code: ErrorCode;
      details: Record<string, unknown>;
    };
    return { ok: false as const, error: { code: body.code, details: body.details } };
  }
  const committed = await deps.repo.experiments.startRun(scope, {
    experimentId: experiment.id,
    flagId: experiment.flagId,
    expectedDraft: {
      draftAllocation: experiment.draftAllocation,
      draftSalt: experiment.draftSalt,
      draftTargetingRules: experiment.draftTargetingRules,
      draftSegmentIds: experiment.draftSegmentIds,
      defaultVariantId: prepared.value.controlVariantId,
      liveRunId: experiment.liveRunId,
    },
    run: {
      id: commit.resultingResourceId,
      targetingKeyField: experiment.targetingKeyField,
      targetingKeyType: experiment.targetingKeyType,
      salt: prepared.value.salt,
      allocation: json(prepared.value.allocation),
      variantSet: json(prepared.value.variantSet),
      targetingRules: json(prepared.value.targetingRules),
      confidenceLevel: experiment.confidenceLevel,
      decisionFamily: json(prepared.value.decisionFamily),
      guardrailDecisions: json(prepared.value.guardrailDecisions),
      configHash: prepared.value.configHash,
      startedAt: commit.reviewedAt,
      startReason:
        typeof request.diff.proposed.startReason === "string"
          ? request.diff.proposed.startReason
          : undefined,
      createdAt: commit.reviewedAt,
      createdBy: commit.reviewedBy,
    },
    endedAt: commit.reviewedAt,
    updatedAt: commit.reviewedAt,
    updatedBy: commit.reviewedBy,
    approval: commit,
  });
  if (!committed.ok) {
    return {
      ok: false as const,
      error: {
        code:
          committed.reason === "experiment_not_found"
            ? ("EXPERIMENT_NOT_FOUND" as const)
            : ("EXPERIMENT_NO_DRAFT" as const),
        details:
          committed.reason === "experiment_not_found"
            ? {}
            : {
                experimentId: experiment.id,
                currentRunId: experiment.liveRunId,
                recommendedAction: "EDIT_DRAFT_THEN_START",
              },
      },
    };
  }
  await syncExperimentConfigFromD1(deps.configStore, scope, experiment.id);
  return { ok: true as const };
}

async function applyVariant(
  deps: ApprovalApplicationDeps,
  request: ApprovalRequest,
  commit: ApprovalCommit,
) {
  const proposed = request.diff.proposed;
  const variant = await deps.repo.flags.getVariantById(appScope(request.appId), request.target.id);
  if (!variant || typeof proposed.flagId !== "string" || proposed.flagId !== variant.flagId) {
    return {
      ok: false as const,
      error: { code: "VARIANT_NOT_FOUND" as const, details: {} },
    };
  }
  const updated = await deps.repo.flags.updateVariant(
    appScope(request.appId),
    variant.flagId,
    variant.name,
    {
      name: requiredString(proposed.name, "name"),
      value: JSON.stringify(proposed.value),
      description: typeof proposed.description === "string" ? proposed.description : null,
    },
    {
      updatedAt: commit.reviewedAt,
      updatedBy: commit.reviewedBy,
      approval: commit,
    },
  );
  if (!updated) {
    return {
      ok: false as const,
      error: { code: "VARIANT_NOT_FOUND" as const, details: {} },
    };
  }
  await resyncFlagSnapshots(deps, request.appId, variant.flagId);
  return { ok: true as const };
}

async function applyVariantCreate(
  deps: ApprovalApplicationDeps,
  request: ApprovalRequest,
  commit: ApprovalCommit,
) {
  const proposed = request.diff.proposed;
  const flagId = requiredString(proposed.flagId, "flagId");
  const created = await deps.repo.flags.addVariant(
    appScope(request.appId),
    flagId,
    {
      id: request.target.id,
      name: requiredString(proposed.name, "name"),
      value: JSON.stringify(proposed.value),
      ...(typeof proposed.description === "string" ? { description: proposed.description } : {}),
      createdAt: commit.reviewedAt,
    },
    { updatedAt: commit.reviewedAt, updatedBy: commit.reviewedBy, approval: commit },
  );
  if (!created) {
    return { ok: false as const, error: { code: "INTERNAL_SERVER_ERROR" as const, details: {} } };
  }
  await resyncFlagSnapshots(deps, request.appId, flagId);
  return { ok: true as const };
}

async function applyVariantDelete(
  deps: ApprovalApplicationDeps,
  request: ApprovalRequest,
  commit: ApprovalCommit,
) {
  const variant = await deps.repo.flags.getVariantById(appScope(request.appId), request.target.id);
  if (!variant) {
    return { ok: false as const, error: { code: "VARIANT_NOT_FOUND" as const, details: {} } };
  }
  const removed = await deps.repo.flags.removeVariant(
    appScope(request.appId),
    variant.flagId,
    variant.name,
    { updatedAt: commit.reviewedAt, updatedBy: commit.reviewedBy, approval: commit },
  );
  if (removed === 0) {
    return { ok: false as const, error: { code: "INTERNAL_SERVER_ERROR" as const, details: {} } };
  }
  await resyncFlagSnapshots(deps, request.appId, variant.flagId);
  return { ok: true as const };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Approval variant proposal is missing ${field}`);
  }
  return value;
}
