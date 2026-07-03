import { envScope } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { nowIso } from "./app-environment-model.js";
import {
  configStoreUnavailable,
  experimentNotFound,
  runNotFound,
  runNotRunning,
} from "./experiment-errors.js";
import { runResponse } from "./experiment-model.js";
import {
  experimentFromPath,
  optionalBody,
  requireWritableEnvironment,
  type ExperimentDeps,
} from "./experiment-handler-shared.js";
import { pathParam } from "./handler-input.js";

export function makeRunHandlers(deps: ExperimentDeps) {
  return {
    listRuns: (args: HandlerArgs<unknown>) => listRuns(deps, args),
    getRun: (args: HandlerArgs<unknown>) => getRun(deps, args),
    endRun: (args: HandlerArgs<unknown>) => endRun(deps, args),
  };
}

async function listRuns(
  deps: ExperimentDeps,
  { input, requestId }: HandlerArgs<unknown>,
): Promise<Response> {
  const scope = envScope(pathParam(input, "appId"), pathParam(input, "environmentId"));
  const experiment = await experimentFromPath(deps, input);
  if (!experiment) return experimentNotFound(requestId);
  const rows = await deps.repo.experiments.listRunsForExperiment(scope, experiment.id);
  return Response.json({ items: rows.sort((a, b) => b.runNumber - a.runNumber).map(runResponse) });
}

async function getRun(deps: ExperimentDeps, { input, requestId }: HandlerArgs<unknown>) {
  const scope = envScope(pathParam(input, "appId"), pathParam(input, "environmentId"));
  const run = await deps.repo.experiments.getRun(scope, pathParam(input, "runId"));
  if (!run || run.experimentId !== pathParam(input, "experimentId")) return runNotFound(requestId);
  return Response.json(runResponse(run));
}

async function endRun(deps: ExperimentDeps, args: HandlerArgs<unknown>): Promise<Response> {
  if (!deps.configStore) return configStoreUnavailable(args.requestId);
  const scope = envScope(pathParam(args.input, "appId"), pathParam(args.input, "environmentId"));
  const run = await deps.repo.experiments.getRun(scope, pathParam(args.input, "runId"));
  if (!run) return runNotFound(args.requestId);
  const writeError = await requireWritableEnvironment(
    deps,
    scope,
    args.principal.id,
    args.requestId,
  );
  if (writeError) return writeError;
  if (run.status !== "running") return runNotRunning(run.id, args.requestId);

  const body = optionalBody(args.input);
  const now = nowIso(deps);
  const ended = await deps.repo.experiments.updateRunStatus(scope, run.id, {
    status: "ended",
    endedAt: now,
    endReason: body.reason as string | undefined,
  });
  if (!ended) return runNotFound(args.requestId);
  await deps.repo.experiments.updateExperiment(scope, run.experimentId, {
    status: "draft",
    liveRunId: null,
    updatedAt: now,
    updatedBy: args.principal.id,
  });
  await deps.configStore.writerFor(scope.appId, scope.environmentId).syncExperimentConfig({
    appId: scope.appId,
    environmentId: scope.environmentId,
    experimentId: run.experimentId,
  });
  return Response.json(runResponse(ended));
}
