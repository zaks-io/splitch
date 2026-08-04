import { type EnvScope, envScope } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { appNotFound, nowIso } from "./app-environment-model";
import { randomHex } from "./credential-cache";
import { experimentDeleteConflict, experimentNotFound } from "./experiment-errors";
import {
  draftPatch,
  type ExperimentDeps,
  environmentExists,
  experimentFromPath,
  nullableString,
  requireWritableEnvironment,
  runningRunForExperiment,
} from "./experiment-handler-shared";
import { experimentResponse, json } from "./experiment-model";
import { makeRunHandlers } from "./experiment-run-handlers";
import { startExperiment } from "./experiment-start-handler";
import {
  loadUpdateContext,
  prepareUpdatePatch,
  validateCreateExperiment,
  validateExperimentPatch,
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

/**
 * A PATCH is decided against a read of the Experiment and then written, and a
 * Run can Start in between. `updateExperiment` compare-and-sets on the live Run
 * id, so a write decided under stale Run state simply does not land — at which
 * point the only correct move is to replay the decision against the new state.
 * Bounded, because a caller must never be able to spin here.
 */
const MAX_UPDATE_ATTEMPTS = 3;

async function updateExperiment(
  deps: ExperimentDeps,
  args: HandlerArgs<unknown>,
): Promise<Response> {
  const scope = envScope(pathParam(args.input, "appId"), pathParam(args.input, "environmentId"));
  const body = objectBody(args.input);
  for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt += 1) {
    const response = await attemptExperimentUpdate(deps, scope, body, args);
    if (response) return response;
  }
  // Losing the compare-and-set this many times in a row is not contention, it is
  // an Experiment whose Run state is being rewritten in a loop. Fail loud.
  throw new Error(
    `updateExperiment: live-Run compare-and-set lost ${MAX_UPDATE_ATTEMPTS} times in a row`,
  );
}

/**
 * One read-guard-write attempt. `null` means the compare-and-set found no row:
 * the Experiment's live Run is no longer the one the guard ruled against (a Run
 * started or ended), or the Experiment was deleted. Both are resolved by the
 * next attempt's fresh read, which either re-guards or 404s.
 */
async function attemptExperimentUpdate(
  deps: ExperimentDeps,
  scope: EnvScope,
  body: Record<string, unknown>,
  args: HandlerArgs<unknown>,
): Promise<Response | null> {
  const context = await loadUpdateContext(deps, scope, args);
  if (!context.ok) return context.response;

  const guard = await validateExperimentPatch(
    deps,
    scope,
    context.experiment,
    body,
    args.requestId,
  );
  if (guard.response) return guard.response;

  // The same Run the guard ruled on. A second read could return a different
  // answer, and then the patch would be built under rules the guard never
  // applied to it.
  const runningRun = body.stageForNextRun === true ? guard.runningRun : null;
  const patch = await prepareUpdatePatch(deps, scope, context.experiment, body, args, runningRun);
  if (!patch.ok) return patch.response;

  const updated = await deps.repo.experiments.updateExperiment(
    scope,
    context.experiment.id,
    patch.value,
    context.experiment.liveRunId,
  );
  return updated ? Response.json(experimentResponse(updated)) : null;
}

async function deleteExperiment(
  deps: ExperimentDeps,
  args: HandlerArgs<unknown>,
): Promise<Response> {
  const scope = envScope(pathParam(args.input, "appId"), pathParam(args.input, "environmentId"));
  // peek includes archived rows so repeat DELETE can be an idempotent success;
  // getExperiment / experimentFromPath hide archived (soft-delete surfaces).
  const experiment = await deps.repo.experiments.peekExperiment(
    scope,
    pathParam(args.input, "experimentId"),
  );
  if (!experiment) return experimentNotFound(args.requestId);
  if (experiment.status === "archived") {
    return Response.json({ deleted: true });
  }
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
  // Guaranteed UPDATE: a concurrent Start winning the race cannot make DELETE
  // report `{ deleted: true }` while the Experiment remains non-archived. If
  // live_run_id / a running Run exists at commit time, D1 applies zero changes
  // and we fail closed with EXPERIMENT_RUNNING. Run rows are retained.
  const archived = await deps.repo.experiments.archiveExperiment(
    scope,
    experiment.id,
    nowIso(deps),
  );
  if (archived === 0) {
    return resolveArchiveRace(deps, scope, experiment.id, args.requestId);
  }
  return Response.json({ deleted: true });
}

async function resolveArchiveRace(
  deps: ExperimentDeps,
  scope: EnvScope,
  experimentId: string,
  requestId: string,
): Promise<Response> {
  const current = await deps.repo.experiments.peekExperiment(scope, experimentId);
  if (!current) return experimentNotFound(requestId);
  if (current.status === "archived") {
    return Response.json({ deleted: true });
  }
  const raced = await runningRunForExperiment(deps.repo, scope, current);
  if (raced) {
    return runningExperimentError(
      { experimentId: current.id, runId: raced.id },
      "DELETE_EXPERIMENT",
      requestId,
    );
  }
  return experimentDeleteConflict(requestId);
}
