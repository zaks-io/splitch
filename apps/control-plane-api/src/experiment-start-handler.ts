import { type EnvScope, envScope, type Repository } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { nowIso } from "./app-environment-model";
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
  syncExperimentConfigFromD1,
} from "./experiment-handler-shared";
import { type ExperimentRow, json, runResponse } from "./experiment-model";
import { prepareStart } from "./experiment-start";
import { validateStartRequest } from "./experiment-start-request";
import { pathParam } from "./handler-input";

/**
 * Start is the only Experiment operation that freezes a Run, so it carries its
 * own validation, draft-snapshot commit, and post-commit KV projection. It lives
 * apart from the CRUD handlers because none of that is shared with them.
 */
export async function startExperiment(
  deps: ExperimentDeps,
  args: HandlerArgs<unknown>,
): Promise<Response> {
  const configStore = deps.configStore;
  if (!configStore) return configStoreUnavailable(args.requestId);
  const scope = envScope(pathParam(args.input, "appId"), pathParam(args.input, "environmentId"));
  const experiment = await experimentFromPath(deps, args.input);
  if (!experiment) return experimentNotFound(args.requestId);
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
