import type { PanelExperimentRouteResolutionOutput } from "@splitch/control-plane-sdk/panel-experiments";
import { appScope, type Repository } from "@splitch/db";
import { panelScopeAccessError } from "./panel-scope-access";

interface RouteResolutionInput {
  actorId: string;
  appId: string;
  targetEnvironmentId: string;
  experimentRef: string;
  runId?: string;
}

export async function panelExperimentRouteResolution(
  deps: { repo: Repository },
  input: RouteResolutionInput,
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const accessError = await panelScopeAccessError(
    deps.repo,
    { actorId: input.actorId, appId: input.appId, environmentId: input.targetEnvironmentId },
    requestId,
  );
  if (accessError) return accessError;

  const scope = appScope(input.appId);
  const environments = await deps.repo.identity.listEnvironments(scope);
  const environmentIds = environments.map((environment) => environment.id);
  const referenced = await deps.repo.experiments.findExperimentsByReferenceAcrossEnvironments(
    scope,
    environmentIds,
    input.experimentRef,
  );
  if (referenced.length === 0) return success({ kind: "experiment_not_found" });
  const keys = new Set(referenced.map((experiment) => experiment.key));
  if (keys.size !== 1) throw new Error("Experiment route reference resolves to multiple keys");
  const experimentKey = referenced[0]?.key;
  if (!experimentKey) throw new Error("Experiment route reference has no stable key");

  const candidates = await deps.repo.experiments.findExperimentsByKeyAcrossEnvironments(
    scope,
    environmentIds,
    experimentKey,
  );
  const target = candidates.find(
    (experiment) => experiment.environmentId === input.targetEnvironmentId,
  );
  if (!input.runId) {
    return target
      ? success({ kind: "experiment", experimentId: target.id, experimentKey })
      : success({ kind: "experiment_not_in_environment", experimentKey });
  }
  return resolveRun(
    deps.repo,
    { ...input, runId: input.runId },
    environments,
    candidates,
    experimentKey,
  );
}

async function resolveRun(
  repo: Repository,
  input: RouteResolutionInput & { runId: string },
  environments: Awaited<ReturnType<Repository["identity"]["listEnvironments"]>>,
  candidates: Awaited<
    ReturnType<Repository["experiments"]["findExperimentsByKeyAcrossEnvironments"]>
  >,
  experimentKey: string,
): Promise<Response> {
  const runs = await repo.experiments.findRunsByIdAcrossEnvironments(
    appScope(input.appId),
    environments.map((environment) => environment.id),
    input.runId,
  );
  const matches = runs.flatMap((run) => {
    const experiment = candidates.find(
      (candidate) =>
        candidate.environmentId === run.environmentId && candidate.id === run.experimentId,
    );
    return experiment ? [experiment] : [];
  });
  if (matches.length === 0) return success({ kind: "run_not_found", experimentKey });
  if (matches.length > 1) throw new Error(`Run ${input.runId} exists in multiple Environments`);
  const experiment = matches[0];
  if (!experiment) throw new Error("Run match disappeared during route resolution");
  if (experiment.environmentId === input.targetEnvironmentId) {
    return success({ kind: "experiment", experimentId: experiment.id, experimentKey });
  }
  const environment = environments.find(({ id }) => id === experiment.environmentId);
  if (!environment) throw new Error(`Run ${input.runId} belongs to an unknown Environment`);
  return success({
    kind: "run_elsewhere",
    env: environment.key,
    experimentId: experiment.id,
    experimentKey,
    runId: input.runId,
  });
}

function success(data: PanelExperimentRouteResolutionOutput): Response {
  return Response.json(data);
}
