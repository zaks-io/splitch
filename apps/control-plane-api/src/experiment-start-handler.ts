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
import type { ConfigStoreAccess } from "./config-store-access";
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
import { type ExperimentRow, json } from "./experiment-model";
import { prepareStart } from "./experiment-start";
import {
  runCommitmentColumns,
  runDecisionSpecFromBody,
  startProposalFields,
} from "./experiment-start-decision-spec";
import {
  lockedGoalMetricIdsFromPrepared,
  resolveStartPreRegistration,
  runMetricIdsFromPrepared,
} from "./experiment-start-preregistration";
import { validateStartRequest } from "./experiment-start-request";
import {
  appliedExperimentStartResponse,
  experimentStartResponse,
} from "./experiment-start-response";
import { readEnvironmentPolicy } from "./flag-config-policy";
import { objectBody, pathParam } from "./handler-input";
import { shipCommittedRunSnapshot } from "./run-snapshot";

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
  const prepared = await prepareStartOrReplaySync(
    deps.repo,
    configStore,
    scope,
    experiment,
    args.requestId,
  );
  if (!prepared.ok) return prepared.response;
  // Validate against the Metrics this Start will freeze so the Approval proposal
  // carries only a pre-registration the Run can honour (plan 2.2).
  const preRegistration = resolveStartPreRegistration(
    body.preRegistration,
    runMetricIdsFromPrepared(prepared.value),
    args.requestId,
    decisionSpec.value.horizon,
    lockedGoalMetricIdsFromPrepared(prepared.value),
  );
  if (!preRegistration.ok) return preRegistration.response;
  const preRegistrationJson = preRegistration.value === null ? null : json(preRegistration.value);

  const policy = await readEnvironmentPolicy(deps.repo, scope.appId, scope.environmentId);
  if (!policy) return appNotFound(args.requestId);
  const contexts = environmentPolicyContexts(scope.environmentId, policy, ["start_experiment_run"]);
  if (contexts.some((context) => context.level !== "allow")) {
    return proposeGatedStart(deps, {
      scope,
      experiment,
      proposalInput,
      contexts,
      principal: args.principal,
      idempotencyKey: startContext.body.idempotency_key as string,
      inlineReview: startContext.body.review !== undefined,
      requestId: args.requestId,
    });
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
      ...runCommitmentColumns(decisionSpec.value, preRegistrationJson),
      decisionFamily: json(prepared.value.decisionFamily),
      guardrailDecisions: json(prepared.value.guardrailDecisions),
      metricVarianceConfig: json(prepared.value.metricVarianceConfig),
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
  const runSnapshotShipped = await shipCommittedRunSnapshot(
    deps.runSnapshotDelivery,
    committed.run,
    scope,
    prepared.value.metricQueryConfig,
    nowIso(deps),
  );

  return Response.json(
    experimentStartResponse({
      experimentId: experiment.id,
      run: committed.run,
      previousRunId: committed.previous?.id ?? null,
      approvalRequest: null,
      appId: scope.appId,
      runSnapshotShipped,
    }),
  );
}

async function proposeGatedStart(
  deps: ExperimentDeps,
  args: {
    scope: EnvScope;
    experiment: ExperimentRow;
    proposalInput: ReturnType<typeof startProposalFields>;
    contexts: ReturnType<typeof environmentPolicyContexts>;
    principal: HandlerArgs<unknown>["principal"];
    idempotencyKey: string;
    inlineReview: boolean;
    requestId: string;
  },
): Promise<Response> {
  const current = {
    ...experimentTargetProjection(args.experiment as unknown as Record<string, unknown>),
    status: "draft",
    startReason: null,
    horizon: null,
    sampleSizeLocked: null,
    targetN: null,
    plannedDurationDays: null,
    plannedDurationOverrideReason: null,
    preRegistration: null,
  };
  // The same fields the idempotency hash was taken over, spread from the same
  // value. The horizon is a Run field with no Experiment column, so the
  // Approval Request is the only place it survives proposal to application.
  const proposed = { ...current, status: "running", ...args.proposalInput };
  const approval = await createApproval(
    {
      ...deps,
      applyOther: makeOtherApprovalApplication(deps),
    },
    {
      appId: args.scope.appId,
      operation: "experiments_start",
      target: { type: "experiment_draft", id: args.experiment.id },
      policyContexts: args.contexts,
      current,
      proposed,
      proposalInput: args.proposalInput,
      principal: args.principal,
      idempotencyKey: args.idempotencyKey,
      inlineReview: args.inlineReview,
      requestId: args.requestId,
    },
  );
  if (!approval.ok) return approval.response;
  return appliedExperimentStartResponse(
    deps,
    args.scope,
    args.experiment.id,
    approval.approvalRequest,
  );
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
