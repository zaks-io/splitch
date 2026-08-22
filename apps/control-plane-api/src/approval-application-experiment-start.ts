import type { ApprovalRequest, ErrorCode } from "@splitch/contracts";
import { type ApprovalCommit, envScope } from "@splitch/db";
import type { ApprovalApplicationDeps } from "./approval-application";
import { nowIso } from "./app-environment-model";
import { syncExperimentConfigFromD1 } from "./experiment-handler-shared";
import { json } from "./experiment-model";
import { prepareStart } from "./experiment-start";
import { decisionSpecFromProposal } from "./experiment-start-decision-spec";
import { shipCommittedRunSnapshot } from "./run-snapshot";

export async function applyExperimentStart(
  deps: ApprovalApplicationDeps,
  request: ApprovalRequest,
  commit: ApprovalCommit,
) {
  // A missing binding is transient and worth retrying; a stored Approval
  // Request with no Environment context is a malformed row and never will be.
  if (!deps.configStore) {
    return {
      ok: false as const,
      targetState: "rolled_back" as const,
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
      targetState: "rolled_back" as const,
      error: { code: "EXPERIMENT_NOT_FOUND" as const, details: {} },
    };
  }
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
      // The Activation Metric defines the Run's analysis entry population and
      // window anchor, so both Start doors must freeze it identically.
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
      metricQueryConfig: json(prepared.value.metricQueryConfig),
      metricVarianceConfig: json(prepared.value.metricVarianceConfig),
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
  await shipCommittedRunSnapshot(deps.runSnapshotDelivery, committed.run, scope, nowIso(deps));
  return { ok: true as const };
}

/** `prepareStart` validates and reads only; it refuses before `startRun` writes. */
async function responseError(response: Response) {
  const body = (await response.json()) as { code: ErrorCode; details: Record<string, unknown> };
  return {
    ok: false as const,
    targetState: "rolled_back" as const,
    error: { code: body.code, details: body.details },
  };
}

function startRunFailure(
  reason: "experiment_not_found" | "stale_draft",
  experiment: { id: string; liveRunId: string | null },
) {
  if (reason === "experiment_not_found") {
    return {
      ok: false as const,
      targetState: "rolled_back" as const,
      error: { code: "EXPERIMENT_NOT_FOUND" as const, details: {} },
    };
  }
  return {
    ok: false as const,
    targetState: "rolled_back" as const,
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

function malformedProposal(field: string) {
  return {
    ok: false as const,
    targetState: "rolled_back" as const,
    error: {
      code: "VALIDATION_ERROR" as const,
      details: { field, reason: "MALFORMED_APPROVAL_PROPOSAL" },
    },
  };
}
