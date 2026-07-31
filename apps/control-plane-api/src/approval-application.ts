import type { ApprovalRequest, ErrorCode } from "@splitch/contracts";
import { type ApprovalCommit, appScope, envScope, type Repository } from "@splitch/db";
import type { ApplicationOutcome } from "./approval-service-types";
import type { ConfigStoreAccess } from "./config-store-do";
import { syncExperimentConfigFromD1 } from "./experiment-handler-shared";
import { json } from "./experiment-model";
import { prepareStart } from "./experiment-start";
import { decisionSpecFromProposal, startReadinessResponse } from "./experiment-start-decision-spec";
import { purgeFlagConfigsKvForKey } from "./flag-config-lifecycle";
import { variantFreezeDetails, type VariantWriteRefusal } from "./flag-definition-errors";
import { resyncFlagSnapshots } from "./flag-definition-handler-utils";

interface ApprovalApplicationDeps {
  repo: Repository;
  configStore?: ConfigStoreAccess;
}

export function makeOtherApprovalApplication(deps: ApprovalApplicationDeps) {
  return async (request: ApprovalRequest, commit: ApprovalCommit): Promise<ApplicationOutcome> => {
    if (request.operation === "flag_variants_update") {
      return applyVariant(deps, request, commit);
    }
    if (request.operation === "flag_variants_create") {
      return applyVariantCreate(deps, request, commit);
    }
    if (request.operation === "flag_variants_delete") {
      return applyVariantDelete(deps, request, commit);
    }
    if (request.operation === "flags_delete") {
      return applyFlagDelete(deps, request, commit);
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

async function responseError(response: Response) {
  const body = (await response.json()) as { code: ErrorCode; details: Record<string, unknown> };
  return { ok: false as const, error: { code: body.code, details: body.details } };
}

async function applyExperimentStart(
  deps: ApprovalApplicationDeps,
  request: ApprovalRequest,
  commit: ApprovalCommit,
) {
  // A missing binding is transient and worth retrying; a stored Approval
  // Request with no Environment context is a malformed row and never will be.
  if (!deps.configStore) {
    return {
      ok: false as const,
      error: { code: "SERVICE_UNAVAILABLE" as const, details: { retryAfterMs: 1000 } },
    };
  }
  const environmentId = request.policyContexts[0]?.environmentId;
  if (!environmentId) return malformedProposal("policyContexts");
  const scope = envScope(request.appId, environmentId);
  const experiment = await deps.repo.experiments.getExperiment(scope, request.target.id);
  if (!experiment) {
    return {
      ok: false as const,
      error: { code: "EXPERIMENT_NOT_FOUND" as const, details: {} },
    };
  }
  // Re-checked at apply rather than only at proposal: nothing freezes the goal
  // Metric family while an Approval Request is pending, so an Experiment can
  // lose it in between and a gated Start would open the undecidable Run the
  // ungated one refuses.
  const readiness = startReadinessResponse(experiment, commit.reviewId);
  if (readiness) return await responseError(readiness);
  const prepared = await prepareStart(deps.repo, scope, experiment, commit.reviewId);
  if (!prepared.ok) return await responseError(prepared.response);
  const decisionSpec = decisionSpecFromProposal(request.diff.proposed);
  if (!decisionSpec) return malformedProposal("sampleSizeLocked");
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
      // Frozen here for the same reason the ungated Start freezes it: the
      // Activation Metric defines the Run's analysis entry population and
      // window anchor (ADR-0012). Dropping it on the gated path alone would
      // make a `confirm` Environment measure a different population than an
      // `allow` one from the same draft.
      activationMetricId: experiment.activationMetricId,
      salt: prepared.value.salt,
      allocation: json(prepared.value.allocation),
      variantSet: json(prepared.value.variantSet),
      targetingRules: json(prepared.value.targetingRules),
      confidenceLevel: experiment.confidenceLevel,
      horizon: decisionSpec.horizon,
      sampleSizeLocked: decisionSpec.sampleSizeLocked,
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
  if (!committed.ok) return startRunFailure(committed.reason, experiment);
  await syncExperimentConfigFromD1(deps.configStore, scope, experiment.id);
  return { ok: true as const };
}

function startRunFailure(
  reason: "experiment_not_found" | "stale_draft",
  experiment: { id: string; liveRunId: string | null },
) {
  if (reason === "experiment_not_found") {
    return { ok: false as const, error: { code: "EXPERIMENT_NOT_FOUND" as const, details: {} } };
  }
  return {
    ok: false as const,
    error: {
      code: "EXPERIMENT_NO_DRAFT" as const,
      details: {
        experimentId: experiment.id,
        currentRunId: experiment.liveRunId,
        recommendedAction: "EDIT_DRAFT_THEN_START",
      },
    },
  };
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
  if (typeof proposed.name !== "string") return malformedProposal("name");
  if (proposed.value === undefined) return malformedProposal("value");
  const updated = await deps.repo.flags.updateVariant(
    appScope(request.appId),
    variant.flagId,
    variant.name,
    {
      name: proposed.name,
      value: JSON.stringify(proposed.value),
      description: typeof proposed.description === "string" ? proposed.description : null,
    },
    {
      updatedAt: commit.reviewedAt,
      updatedBy: commit.reviewedBy,
      approval: commit,
    },
  );
  // A proposal filed BEFORE a Run started and approved AFTER it is the second
  // door onto this mutation — for the name AND for the value — and the same
  // repository seam refuses both. A value swap landing here is the quieter of
  // the two: it would return `applied`, republish KV, and leave the live Run
  // serving the same arm name with a different payload, so the analysis
  // population mixes two treatments with no error anywhere. The refusal is
  // recorded on the Review as a machine-stable reason rather than swallowed as
  // `notApplied`, which reads as a lost race worth retrying — a retry that can
  // never succeed while the Run lives (ADR-0036: no impossible remedy).
  if (!updated.ok) return variantApplicationRefusal(updated);
  await resyncFlagSnapshots(deps, request.appId, variant.flagId);
  return { ok: true as const };
}

/**
 * The sibling of `variantWriteRefusal` on the direct route: every reason gets an
 * outcome, and the outcomes stay DISTINCT. `NOT_FOUND` used to be swallowed by
 * the `notApplied` catch-all, which reads as a lost race worth another Review —
 * a retry that can never find a Variant that no longer exists (ADR-0036).
 */
export function variantApplicationRefusal(refusal: VariantWriteRefusal): ApplicationOutcome {
  switch (refusal.reason) {
    // A proposal filed BEFORE a Run started and approved AFTER it is the second
    // door onto this mutation — for the name AND for the value — and the same
    // repository seam refuses both. A value swap landing here is the quieter of
    // the two: it would return `applied`, republish KV, and leave the live Run
    // serving the same arm name with a different payload, so the analysis
    // population mixes two treatments with no error anywhere. Recorded on the
    // Review as a machine-stable RUN_FROZEN rather than as a retryable race.
    case "RUN_FROZEN":
      return {
        ok: false,
        error: { code: "RUN_FROZEN" as const, details: variantFreezeDetails(refusal) },
      };
    // The Variant was read at the top of `applyVariant`, so this is a concurrent
    // delete between that read and the guarded write.
    case "NOT_FOUND":
      return { ok: false, error: { code: "VARIANT_NOT_FOUND" as const, details: {} } };
    // The guarded write selected zero rows: reconciliation decides stale vs
    // resolved.
    case "NOT_APPLIED":
      return notApplied();
    default:
      return unhandledRefusal(refusal);
  }
}

/** A reason added to the union without an outcome must not resolve as applied. */
function unhandledRefusal(refusal: never): never {
  throw new Error(`unhandled updateVariant refusal: ${JSON.stringify(refusal)}`);
}

async function applyVariantCreate(
  deps: ApprovalApplicationDeps,
  request: ApprovalRequest,
  commit: ApprovalCommit,
) {
  const proposed = request.diff.proposed;
  const flagId = proposed.flagId;
  if (typeof flagId !== "string") return malformedProposal("flagId");
  if (typeof proposed.name !== "string") return malformedProposal("name");
  if (proposed.value === undefined) return malformedProposal("value");
  const created = await deps.repo.flags.addVariant(
    appScope(request.appId),
    flagId,
    {
      id: request.target.id,
      name: proposed.name,
      value: JSON.stringify(proposed.value),
      ...(typeof proposed.description === "string" ? { description: proposed.description } : {}),
      createdAt: commit.reviewedAt,
    },
    { updatedAt: commit.reviewedAt, updatedBy: commit.reviewedBy, approval: commit },
  );
  if (!created) return notApplied();
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
  if (removed === 0) return notApplied();
  await resyncFlagSnapshots(deps, request.appId, variant.flagId);
  return { ok: true as const };
}

/**
 * Deleting a Flag destroys every Environment's Configuration and targeting
 * rules for it. D1 goes first and is guarded by the Review, so a lost race
 * leaves KV untouched; purging KV first would leave a `confirm` Environment
 * unserved on a delete that never legally applied.
 */
async function applyFlagDelete(
  deps: ApprovalApplicationDeps,
  request: ApprovalRequest,
  commit: ApprovalCommit,
) {
  const flagId = request.target.id;
  const flag = await deps.repo.flags.getFlag(appScope(request.appId), flagId);
  if (!flag) {
    return { ok: false as const, error: { code: "FLAG_NOT_FOUND" as const, details: {} } };
  }
  const environments = await deps.repo.identity.listEnvironments(appScope(request.appId));
  const deleted = await deps.repo.flags.deleteFlagCascade(
    appScope(request.appId),
    flagId,
    environments.map((environment) => environment.id),
    { approval: commit },
  );
  if (!deleted) return notApplied();
  await purgeFlagConfigsKvForKey(deps, request.appId, flagId, flag.key);
  return { ok: true as const };
}

/**
 * The Approval-guarded write selected zero rows: nothing was applied, and the
 * reconciliation re-reads the stored state to decide `stale` vs a recorded
 * failure. Reporting it as a failure here would bury a legitimate race.
 */
function notApplied() {
  return { ok: false as const, notApplied: true as const };
}

/**
 * A stored proposal that cannot be read is a recorded application failure, not
 * a thrown exception: every other branch here returns `{ ok: false, error }` so
 * the Review row keeps a machine-stable reason, and a throw would instead land
 * as an anonymous INTERNAL_SERVER_ERROR through the catch in
 * `approval-review-application.ts`.
 */
function malformedProposal(field: string) {
  return {
    ok: false as const,
    error: {
      code: "VALIDATION_ERROR" as const,
      details: { field, reason: "MALFORMED_APPROVAL_PROPOSAL" },
    },
  };
}
