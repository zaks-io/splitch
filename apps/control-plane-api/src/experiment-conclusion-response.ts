import {
  type ApprovalRequest,
  canonicalJson,
  type ConcludeRunRequest,
  type ConcludeRunResponse,
  type CreateConclusionPromotionRequest,
  type CreateConclusionPromotionResponse,
} from "@splitch/contracts";
import { appScope, envScope } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { approvalRequestProjection } from "./approval-model";
import { reviewApproval } from "./approval-service";
import { conclusionProjectionUnavailable } from "./experiment-conclusion-errors";
import type { ExperimentDeps } from "./experiment-handler-shared";
import { runResponse } from "./experiment-model";
import { pathParam } from "./handler-input";

export type ConclusionPathIds = ReturnType<typeof conclusionPathIds>;

export function conclusionPathIds(input: unknown) {
  return {
    appId: pathParam(input, "appId"),
    environmentId: pathParam(input, "environmentId"),
    experimentId: pathParam(input, "experimentId"),
    runId: pathParam(input, "runId"),
  };
}

export async function replayConclusion(
  deps: ExperimentDeps,
  args: HandlerArgs<unknown>,
  body: ConcludeRunRequest,
  conclusion: NonNullable<
    Awaited<ReturnType<typeof deps.repo.experimentConclusions.getByActorKey>>
  >,
) {
  const links = await deps.repo.experimentConclusions.listApprovalLinks(
    appScope(conclusion.appId),
    conclusion.id,
  );
  const link = links.find((candidate) => candidate.ordinal === 1);
  if (!link) throw new Error("conclusion replay has no initial Approval Request");
  return finishConclusion(deps, args, body, conclusion.id, link.approvalRequestId);
}

export async function finishConclusion(
  deps: ExperimentDeps,
  args: HandlerArgs<unknown>,
  body: ConcludeRunRequest,
  conclusionId: string,
  approvalId: string,
): Promise<Response> {
  const ids = conclusionPathIds(args.input);
  const sync = await deps.configStore
    ?.writerFor(ids.appId, ids.environmentId)
    .syncExperimentConfig({
      appId: ids.appId,
      environmentId: ids.environmentId,
      experimentId: ids.experimentId,
    });
  if (!sync?.ok) {
    return conclusionProjectionUnavailable(conclusionId, approvalId, args.requestId);
  }
  if (body.review) {
    const reviewed = await reviewApproval(deps, {
      appId: ids.appId,
      approvalRequestId: approvalId,
      action: "approve_and_apply",
      reason: null,
      idempotencyKey: body.idempotencyKey,
      principal: args.principal,
      requestId: args.requestId,
    });
    if (!reviewed.ok) return reviewed.response;
  }
  const scope = envScope(ids.appId, ids.environmentId);
  const [conclusion, run, approval] = await Promise.all([
    deps.repo.experimentConclusions.get(scope, ids.experimentId, ids.runId, conclusionId),
    deps.repo.experiments.getRun(scope, ids.runId),
    deps.repo.approvals.getRequest(appScope(ids.appId), approvalId),
  ]);
  if (!conclusion || !run || !approval) {
    throw new Error("committed conclusion could not be reloaded");
  }
  const response: ConcludeRunResponse = {
    run: runResponse(run),
    conclusion: conclusionProjection(conclusion),
    approvalRequest: await approvalRequestProjection(deps.repo, approval),
  };
  return Response.json(response);
}

export async function finishReplacement(
  deps: ExperimentDeps,
  args: HandlerArgs<unknown>,
  body: CreateConclusionPromotionRequest,
  conclusion: NonNullable<Awaited<ReturnType<typeof deps.repo.experimentConclusions.get>>>,
  approvalId: string,
) {
  if (body.review) {
    const reviewed = await reviewApproval(deps, {
      appId: conclusion.appId,
      approvalRequestId: approvalId,
      action: "approve_and_apply",
      reason: null,
      idempotencyKey: body.idempotencyKey,
      principal: args.principal,
      requestId: args.requestId,
    });
    if (!reviewed.ok) return reviewed.response;
  }
  const row = await deps.repo.approvals.getRequest(appScope(conclusion.appId), approvalId);
  if (!row) throw new Error("replacement Approval Request could not be reloaded");
  const response: CreateConclusionPromotionResponse = {
    conclusion: conclusionProjection(conclusion),
    approvalRequest: await approvalRequestProjection(deps.repo, row),
  };
  return Response.json(response);
}

function conclusionProjection(conclusion: {
  id: string;
  runId: string;
  selectedVariant: string;
  resultToken: string;
  dataWatermark: string;
  concludedAt: string;
}) {
  return {
    id: conclusion.id,
    runId: conclusion.runId,
    selectedVariant: conclusion.selectedVariant,
    resultToken: conclusion.resultToken as `sha256:${string}`,
    dataWatermark: conclusion.dataWatermark,
    concludedAt: conclusion.concludedAt,
  };
}

export function winnerApprovalRow(input: {
  id: string;
  targetId: string;
  targetVersion: string;
  policyContexts: ApprovalRequest["policyContexts"];
  policyGuardContexts: ApprovalRequest["policyContexts"];
  diff: ApprovalRequest["diff"];
  proposedBy: string;
  proposedVia: string;
  proposedAt: string;
  idempotencyKey: string;
  requestHash: string;
}) {
  return {
    id: input.id,
    operation: "experiment_winner_promote",
    targetType: "flag_configuration",
    targetId: input.targetId,
    targetVersion: input.targetVersion,
    policyContexts: canonicalJson(input.policyContexts),
    policyGuardContexts: canonicalJson(input.policyGuardContexts),
    diff: canonicalJson(input.diff),
    status: "pending",
    proposedBy: input.proposedBy,
    proposedVia: input.proposedVia,
    proposedAt: input.proposedAt,
    resolvedAt: null,
    resultingTargetVersion: null,
    resultingResourceType: null,
    resultingResourceId: null,
    idempotencyKey: input.idempotencyKey,
    requestHash: input.requestHash,
  };
}
