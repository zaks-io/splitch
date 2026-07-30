import { type EnvScope, envScope, type Repository } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { appNotFound, nowIso } from "./app-environment-model";
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
  draftPatch,
  type ExperimentDeps,
  environmentExists,
  experimentFromPath,
  nullableString,
  requireWritableEnvironment,
  runningRunForExperiment,
  syncExperimentConfigFromD1,
} from "./experiment-handler-shared";
import { type ExperimentRow, experimentResponse, json, runResponse } from "./experiment-model";
import { makeRunHandlers } from "./experiment-run-handlers";
import { prepareStart } from "./experiment-start";
import { validateStartRequest } from "./experiment-start-request";
import {
  loadUpdateContext,
  prepareUpdatePatch,
  validateCreateExperiment,
  validateRunningPatch,
} from "./experiment-update-plan";
import { runningExperimentError } from "./flag-definition-errors";
import { objectBody, pathParam } from "./handler-input";

export function makeExperimentHandlers(deps: ExperimentDeps) {
  return {
    listExperiments: (args: HandlerArgs<unknown>) => listExperiments(deps, args),
    createExperiment: (args: HandlerArgs<unknown>) => createExperiment(deps, args),
    getExperiment: (args: HandlerArgs<unknown>) => getExperiment(deps, args),
    updateExperiment: (args: HandlerArgs<unknown>) => updateExperiment(deps, args),
    deleteExperiment: (args: HandlerArgs<unknown>) => deleteExperiment(deps, args),
    startExperiment: (args: HandlerArgs<unknown>) => startExperiment(deps, args),
    ...makeRunHandlers(deps),
  };
}

async function listExperiments(
  deps: ExperimentDeps,
  { input, requestId }: HandlerArgs<unknown>,
): Promise<Response> {
  const scope = envScope(pathParam(input, "appId"), pathParam(input, "environmentId"));
  if (!(await environmentExists(deps, scope))) return appNotFound(requestId);
  const rows = await deps.repo.experiments.listExperiments(scope);
  return Response.json({ items: rows.map(experimentResponse) });
}

async function createExperiment(
  deps: ExperimentDeps,
  { input, principal, requestId }: HandlerArgs<unknown>,
): Promise<Response> {
  const scope = envScope(pathParam(input, "appId"), pathParam(input, "environmentId"));
  const body = objectBody(input);
  const writeError = await requireWritableEnvironment(deps, scope, principal, requestId);
  if (writeError) return writeError;

  const ready = await validateCreateExperiment(deps, scope, body, requestId);
  if (!ready.ok) return ready.response;

  const now = nowIso(deps);
  const row = await deps.repo.experiments.experiments.insert(scope, {
    id: `exp_${randomHex(12)}`,
    appId: scope.appId,
    environmentId: scope.environmentId,
    key: body.key as string,
    flagId: body.flagId as string,
    name: body.name as string,
    ...(body.description ? { description: body.description as string } : {}),
    ...(body.hypothesis ? { hypothesis: body.hypothesis as string } : {}),
    status: "draft",
    targetingKeyField: body.targetingKey as string,
    targetingKeyType: body.targetingKeyType as string,
    confidenceLevel: body.confidenceLevel as number,
    defaultVariantId: ready.defaultVariantId,
    metrics: json(body.metrics ?? []),
    guardrailMetrics: json(body.guardrailMetrics ?? []),
    activationMetricId: nullableString(body.activationMetricId),
    conversionWindowMs: body.conversionWindowMs as number,
    dimensions: json(body.dimensions ?? []),
    ...draftPatch(body),
    liveRunId: null,
    createdAt: now,
    updatedAt: now,
    createdBy: principal.id,
    updatedBy: principal.id,
  });
  return Response.json(experimentResponse(row));
}

async function getExperiment(
  deps: ExperimentDeps,
  { input, requestId }: HandlerArgs<unknown>,
): Promise<Response> {
  const experiment = await experimentFromPath(deps, input);
  if (!experiment) return experimentNotFound(requestId);
  return Response.json(experimentResponse(experiment));
}

async function updateExperiment(
  deps: ExperimentDeps,
  args: HandlerArgs<unknown>,
): Promise<Response> {
  const scope = envScope(pathParam(args.input, "appId"), pathParam(args.input, "environmentId"));
  const body = objectBody(args.input);

  const context = await loadUpdateContext(deps, scope, args);
  if (!context.ok) return context.response;

  const guardError = await validateRunningPatch(
    deps,
    scope,
    context.experiment,
    body,
    args.requestId,
  );
  if (guardError) return guardError;

  const runningRun =
    body.stageForNextRun === true
      ? await runningRunForExperiment(deps.repo, scope, context.experiment)
      : null;
  const patch = await prepareUpdatePatch(deps, scope, context.experiment, body, args, runningRun);
  if (!patch.ok) return patch.response;

  const updated = await deps.repo.experiments.updateExperiment(
    scope,
    context.experiment.id,
    patch.value,
  );
  if (!updated) return experimentNotFound(args.requestId);
  return Response.json(experimentResponse(updated));
}

async function deleteExperiment(
  deps: ExperimentDeps,
  args: HandlerArgs<unknown>,
): Promise<Response> {
  const scope = envScope(pathParam(args.input, "appId"), pathParam(args.input, "environmentId"));
  const experiment = await experimentFromPath(deps, args.input);
  if (!experiment) return experimentNotFound(args.requestId);
  const writeError = await requireWritableEnvironment(deps, scope, args.principal, args.requestId);
  if (writeError) return writeError;
  const runningRun = await runningRunForExperiment(deps.repo, scope, experiment);
  if (runningRun) {
    return runningExperimentError(
      { experimentId: experiment.id, runId: runningRun.id },
      "DELETE_EXPERIMENT",
      args.requestId,
    );
  }
  await deps.repo.experiments.removeExperiment(scope, experiment.id);
  return Response.json({ deleted: true });
}

async function startExperiment(
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
