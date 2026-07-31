/**
 * Starting an Experiment Run is the one Experiment write that publishes traffic
 * allocation to the edge, so it carries the `start_experiment_run` Approval gate,
 * the Approval replay path, and the draft-staleness resync. It lives apart from
 * the Experiment CRUD handlers because none of that machinery is shared with them.
 */

import { type EnvScope, envScope, type Repository } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { appNotFound, nowIso } from "./app-environment-model";
import { makeOtherApprovalApplication } from "./approval-application";
import { createApproval, replayApprovalIfExists } from "./approval-service";
import { environmentPolicyContexts } from "./approval-target";
import { experimentTargetProjection } from "./approval-target-experiment";
import type { ConfigStoreAccess } from "./config-store-do";
import { randomHex } from "./credential-cache";
import {
  configStoreUnavailable,
  experimentAlreadyRunningForFlag,
  experimentNoDraft,
  experimentNotFound,
} from "./experiment-errors";
import {
  blockingRunningExperimentForStart,
  type ExperimentDeps,
  experimentFromPath,
  requireWritableEnvironment,
  syncExperimentConfigFromD1,
} from "./experiment-handler-shared";
import { type ExperimentRow, json, runResponse } from "./experiment-model";
import { prepareStart } from "./experiment-start";
import {
  runDecisionSpecFromBody,
  startProposalFields,
  startReadinessResponse,
} from "./experiment-start-decision-spec";
import { validateStartRequest } from "./experiment-start-request";
import { readEnvironmentPolicy } from "./flag-config-policy";
import { objectBody, pathParam } from "./handler-input";

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: start validation and Approval gating must precede every state mutation
export async function startExperiment(
  deps: ExperimentDeps,
  args: HandlerArgs<unknown>,
): Promise<Response> {
  const configStore = deps.configStore;
  if (!configStore) return configStoreUnavailable(args.requestId);
  const scope = envScope(pathParam(args.input, "appId"), pathParam(args.input, "environmentId"));
  const experiment = await experimentFromPath(deps, args.input);
  if (!experiment) return experimentNotFound(args.requestId);
  const body = objectBody(args.input);
  const writeError = await requireWritableEnvironment(deps, scope, args.principal, args.requestId);
  if (writeError) return writeError;
  // Parsed BEFORE the replay lookup: the horizon and the pre-registered sample
  // size change what a Start writes, so the idempotency identity has to cover
  // them or a same-key retry with different intent replays a stale proposal.
  const decisionSpec = runDecisionSpecFromBody(body, args.requestId);
  if (!decisionSpec.ok) return decisionSpec.response;
  const proposalInput = startProposalFields(body, decisionSpec.value);
  const replay = await replayExperimentStart(deps, args, scope, experiment.id, body, proposalInput);
  if (replay) return replay;
  const startContext = await validateStartRequest(deps, args, scope, experiment);
  if (!startContext.ok) return startContext.response;
  const readiness = startReadinessResponse(experiment, args.requestId);
  if (readiness) return readiness;

  const prepared = await prepareStartOrReplaySync(
    deps.repo,
    configStore,
    scope,
    experiment,
    args.requestId,
  );
  if (!prepared.ok) return prepared.response;

  const policy = await readEnvironmentPolicy(deps.repo, scope.appId, scope.environmentId);
  if (!policy) return appNotFound(args.requestId);
  const contexts = environmentPolicyContexts(scope.environmentId, policy, ["start_experiment_run"]);
  if (contexts.some((context) => context.level !== "allow")) {
    const current = {
      ...experimentTargetProjection(experiment as unknown as Record<string, unknown>),
      status: "draft",
      startReason: null,
      horizon: null,
      sampleSizeLocked: null,
    };
    // The same fields the idempotency hash was taken over, spread from the same
    // value. The horizon is a Run field with no Experiment column, so the
    // Approval Request is the only place it survives proposal to application.
    const proposed = { ...current, status: "running", ...proposalInput };
    const approval = await createApproval(
      {
        ...deps,
        applyOther: makeOtherApprovalApplication(deps),
      },
      {
        appId: scope.appId,
        operation: "experiments_start",
        target: { type: "experiment_draft", id: experiment.id },
        policyContexts: contexts,
        current,
        proposed,
        proposalInput,
        principal: args.principal,
        idempotencyKey: startContext.body.idempotency_key as string,
        inlineReview: startContext.body.review !== undefined,
        requestId: args.requestId,
      },
    );
    if (!approval.ok) return approval.response;
    return appliedExperimentStartResponse(deps, scope, experiment.id, approval.approvalRequest);
  }

  const now = nowIso(deps);
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
      id: `run_${randomHex(12)}`,
      targetingKeyField: experiment.targetingKeyField,
      targetingKeyType: experiment.targetingKeyType,
      activationMetricId: experiment.activationMetricId,
      salt: prepared.value.salt,
      allocation: json(prepared.value.allocation),
      variantSet: json(prepared.value.variantSet),
      targetingRules: json(prepared.value.targetingRules),
      confidenceLevel: experiment.confidenceLevel,
      horizon: decisionSpec.value.horizon,
      sampleSizeLocked: decisionSpec.value.sampleSizeLocked,
      decisionFamily: json(prepared.value.decisionFamily),
      guardrailDecisions: json(prepared.value.guardrailDecisions),
      configHash: prepared.value.configHash,
      startedAt: now,
      startReason: startContext.body.reason as string | undefined,
      createdAt: now,
      createdBy: args.principal.id,
    },
    endedAt: now,
    updatedAt: now,
    updatedBy: args.principal.id,
  });
  if (!committed.ok) {
    if (committed.reason === "experiment_not_found") return experimentNotFound(args.requestId);
    const staleBlocker = await blockingRunningExperimentForStart(deps.repo, scope, experiment);
    if (staleBlocker) {
      return experimentAlreadyRunningForFlag(
        staleBlocker.experimentId,
        staleBlocker.runId,
        args.requestId,
      );
    }
    return staleStartResponse(deps.repo, configStore, scope, experiment, args.requestId);
  }

  await syncExperimentConfigFromD1(configStore, scope, experiment.id);

  return Response.json({
    experimentId: experiment.id,
    run: runResponse(committed.run),
    previousRunId: committed.previous?.id ?? null,
    approvalRequest: null,
  });
}

async function replayExperimentStart(
  deps: ExperimentDeps,
  args: HandlerArgs<unknown>,
  scope: EnvScope,
  experimentId: string,
  body: Record<string, unknown>,
  proposalInput: Record<string, unknown>,
): Promise<Response | null> {
  const replay = await replayApprovalIfExists(
    {
      ...deps,
      applyOther: makeOtherApprovalApplication(deps),
    },
    {
      appId: scope.appId,
      operation: "experiments_start",
      target: { type: "experiment_draft", id: experimentId },
      proposalInput,
      principal: args.principal,
      idempotencyKey: body.idempotency_key as string,
      inlineReview: body.review !== undefined,
      requestId: args.requestId,
    },
    { ignoreMismatch: true },
  );
  if (!replay) return null;
  if (!replay.ok) return replay.response;
  return appliedExperimentStartResponse(deps, scope, experimentId, replay.approvalRequest);
}

/**
 * Only reached for an `applied` Approval Request, so the application result and
 * the Run it names both have to exist. A 404 here would blame a missing
 * Experiment for what is really a broken applied record, so it fails loud
 * instead (ADR-0036).
 */
async function appliedExperimentStartResponse(
  deps: ExperimentDeps,
  scope: EnvScope,
  experimentId: string,
  approvalRequest: import("@splitch/contracts").ApprovalRequest,
) {
  const result = approvalRequest.applicationResult;
  if (!result) {
    throw new Error(`applied Approval Request ${approvalRequest.id} carries no application result`);
  }
  const run = await deps.repo.experiments.getRun(scope, result.resourceId);
  if (!run) {
    throw new Error(
      `applied Approval Request ${approvalRequest.id} names Run ${result.resourceId}, which does not exist`,
    );
  }
  const previousRunId = approvalRequest.diff.current.liveRunId;
  return Response.json({
    experimentId,
    run: runResponse(run),
    previousRunId: typeof previousRunId === "string" ? previousRunId : null,
    approvalRequest,
  });
}

async function prepareStartOrReplaySync(
  repo: Repository,
  configStore: ConfigStoreAccess,
  scope: EnvScope,
  experiment: ExperimentRow,
  requestId: string,
): ReturnType<typeof prepareStart> {
  if (experiment.draftAllocation !== null) return prepareStart(repo, scope, experiment, requestId);
  return {
    ok: false,
    response: await staleStartResponse(repo, configStore, scope, experiment, requestId),
  };
}

async function staleStartResponse(
  repo: Repository,
  configStore: ConfigStoreAccess,
  scope: EnvScope,
  experiment: ExperimentRow,
  requestId: string,
): Promise<Response> {
  const currentRunId = await replayStartedExperimentSync(repo, configStore, scope, experiment.id);
  return experimentNoDraft(experiment.id, currentRunId ?? experiment.liveRunId, requestId);
}

async function replayStartedExperimentSync(
  repo: Repository,
  configStore: ConfigStoreAccess,
  scope: EnvScope,
  experimentId: string,
): Promise<string | null> {
  const current = await repo.experiments.getExperiment(scope, experimentId);
  if (current?.status !== "running" || !current.liveRunId) return null;
  await syncExperimentConfigFromD1(configStore, scope, experimentId);
  return current.liveRunId;
}
