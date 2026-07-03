import { envScope } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { appNotFound, nowIso } from "./app-environment-model.js";
import { randomHex } from "./credential-cache.js";
import { configStoreUnavailable, experimentNotFound } from "./experiment-errors.js";
import { experimentResponse, json, runResponse } from "./experiment-model.js";
import {
  draftPatch,
  environmentExists,
  experimentFromPath,
  nullableString,
  optionalBody,
  requireWritableEnvironment,
  runningRunForExperiment,
  type ExperimentDeps,
} from "./experiment-handler-shared.js";
import { makeRunHandlers } from "./experiment-run-handlers.js";
import { prepareStart } from "./experiment-start.js";
import {
  loadUpdateContext,
  prepareUpdatePatch,
  validateCreateExperiment,
  validateRunningPatch,
} from "./experiment-update-plan.js";
import { runningExperimentError } from "./flag-definition-errors.js";
import { confirmationRequired, readEnvironmentPolicy } from "./flag-config-policy.js";
import { objectBody, pathParam } from "./handler-input.js";

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
  const writeError = await requireWritableEnvironment(deps, scope, principal.id, requestId);
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

  const patch = await prepareUpdatePatch(deps, scope, context.experiment, body, args);
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
  const writeError = await requireWritableEnvironment(
    deps,
    scope,
    args.principal.id,
    args.requestId,
  );
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
  if (!deps.configStore) return configStoreUnavailable(args.requestId);
  const scope = envScope(pathParam(args.input, "appId"), pathParam(args.input, "environmentId"));
  const experiment = await experimentFromPath(deps, args.input);
  if (!experiment) return experimentNotFound(args.requestId);
  const writeError = await requireWritableEnvironment(
    deps,
    scope,
    args.principal.id,
    args.requestId,
  );
  if (writeError) return writeError;

  const body = optionalBody(args.input);
  const policy = await readEnvironmentPolicy(deps.repo, scope.appId, scope.environmentId);
  if (!policy) return appNotFound(args.requestId);
  const confirmation = confirmationRequired(
    policy,
    ["start_experiment_run"],
    body.confirm === true,
    scope.environmentId,
    "START_EXPERIMENT_RUN",
    args.requestId,
  );
  if (confirmation) return confirmation;

  const prepared = await prepareStart(deps.repo, scope, experiment, args.requestId);
  if (!prepared.ok) return prepared.response;

  const now = nowIso(deps);
  const previous = await runningRunForExperiment(deps.repo, scope, experiment);
  if (previous) {
    await deps.repo.experiments.updateRunStatus(scope, previous.id, {
      status: "ended",
      endedAt: now,
    });
  }

  const run = await deps.repo.experiments.runs.insert(scope, {
    id: `run_${randomHex(12)}`,
    appId: scope.appId,
    environmentId: scope.environmentId,
    experimentId: experiment.id,
    runNumber: await deps.repo.experiments.nextRunNumber(scope, experiment.id),
    status: "running",
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
    startedAt: now,
    startReason: body.reason as string | undefined,
    createdAt: now,
    createdBy: args.principal.id,
  });

  await deps.repo.experiments.updateExperiment(scope, experiment.id, {
    status: "running",
    liveRunId: run.id,
    draftSalt: null,
    updatedAt: now,
    updatedBy: args.principal.id,
  });
  await deps.configStore.writerFor(scope.appId, scope.environmentId).writeLiveRun({
    appId: scope.appId,
    environmentId: scope.environmentId,
    experimentId: experiment.id,
    runId: run.id,
  });

  return Response.json({
    experimentId: experiment.id,
    run: runResponse(run),
    previousRunId: previous?.id ?? null,
  });
}
