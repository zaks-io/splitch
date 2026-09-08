import {
  ApprovalDiffSchema,
  canonicalHash,
  canonicalJson,
  type ConcludeRunRequest,
  type ExperimentDecisionGate,
} from "@splitch/contracts";
import { appScope, envScope } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { approvalDiff, approvalRequestId } from "./approval-canonical";
import { idempotencyConflict, requiredAuthDoor } from "./approval-review-outcomes";
import type { PreparedWinnerProposal } from "./experiment-conclusion-proposal";
import {
  type ConclusionPathIds,
  finishConclusion,
  replayConclusion,
  winnerApprovalRow,
} from "./experiment-conclusion-response";
import type { ExperimentDeps } from "./experiment-handler-shared";

interface ConclusionContext {
  ids: ConclusionPathIds;
  body: ConcludeRunRequest;
  requestHash: string;
  conclusionId: string;
  now: string;
  run: {
    id: string;
    configHash: string;
  };
  experiment: { id: string };
  prepared: PreparedWinnerProposal;
  evidence: {
    resultToken: `sha256:${string}`;
    dataWatermark: string;
    stats: unknown;
    gate: ExperimentDecisionGate;
  };
}

export async function commitConclusion(
  deps: ExperimentDeps,
  args: HandlerArgs<unknown>,
  context: ConclusionContext,
): Promise<Response> {
  const { ids, body, conclusionId, now, run, experiment, prepared, evidence } = context;
  const decision = {
    conclusionId,
    runId: run.id,
    selectedVariant: body.selectedVariant,
    resultToken: evidence.resultToken,
  };
  const diff = ApprovalDiffSchema.parse(
    approvalDiff(
      { decision, flagConfiguration: prepared.current },
      { decision, flagConfiguration: prepared.proposed },
    ),
  );
  const approvalId = approvalRequestId(new Date(now).getTime());
  const approvalHash = await canonicalHash({
    operation: "experiment_winner_promote",
    target: { type: "flag_configuration", id: prepared.targetId },
    proposalInput: { conclusionId },
  });
  if (
    await deps.repo.approvals.getRequestByActorKey(
      appScope(ids.appId),
      args.principal.id,
      body.idempotencyKey,
    )
  ) {
    return idempotencyConflict("conclusion", body.idempotencyKey, args.requestId);
  }
  const committed = await deps.repo.experimentConclusions.commit(
    envScope(ids.appId, ids.environmentId),
    {
      expectedLiveRunId: run.id,
      expectedTargetConfigVersion: body.target.expectedConfigVersion,
      conclusion: {
        id: conclusionId,
        environmentId: ids.environmentId,
        experimentId: experiment.id,
        runId: run.id,
        selectedVariant: body.selectedVariant,
        configHash: run.configHash,
        resultToken: evidence.resultToken,
        dataWatermark: evidence.dataWatermark,
        resultSnapshot: canonicalJson(evidence.stats),
        decisionFailures: "[]",
        decisionChecks: canonicalJson(evidence.gate.checks),
        targetEnvironmentId: body.target.environmentId,
        targetFlagId: body.target.flagId,
        targetConfigVersion: body.target.expectedConfigVersion,
        proposedFlagConfiguration: canonicalJson(prepared.proposed),
        reason: body.reason ?? null,
        concludedBy: args.principal.id,
        concludedVia: requiredAuthDoor(args.principal),
        concludedAt: now,
        idempotencyKey: body.idempotencyKey,
        requestHash: context.requestHash,
      },
      approval: winnerApprovalRow({
        id: approvalId,
        targetId: prepared.targetId,
        targetVersion: prepared.targetVersion,
        policyContexts: prepared.policyContexts,
        policyGuardContexts: prepared.policyGuardContexts,
        diff,
        proposedBy: args.principal.id,
        proposedVia: requiredAuthDoor(args.principal),
        proposedAt: now,
        idempotencyKey: body.idempotencyKey,
        requestHash: approvalHash,
      }),
    },
  );
  if (!committed.ok) return replayConclusion(deps, args, body, committed.replay);
  return finishConclusion(deps, args, body, conclusionId, approvalId);
}
