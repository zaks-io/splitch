import {
  type PanelExperimentHealth,
  type PanelExperimentListItem,
  parseScopedAnalysisResults,
  scopedAnalysisResultsRequest,
} from "@splitch/control-plane-sdk/panel-experiments";
import { appScope, envScope, type Repository } from "@splitch/db";
import { renderError } from "@splitch/worker-runtime";
import { experimentResponse } from "./experiment-model";

interface PanelExperimentsDeps {
  repo: Repository;
  analysis: Fetcher;
}

interface PanelExperimentsInput {
  actorId: string;
  appId: string;
  environmentId: string;
}

export async function panelExperimentsList(
  deps: PanelExperimentsDeps,
  input: PanelExperimentsInput,
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const app = await deps.repo.identity.getApp(input.appId);
  if (!app) return notFound("App not found", requestId);

  const [orgMembership, appMembership, environment] = await Promise.all([
    deps.repo.identity.getOrgMembership(app.organizationId, input.actorId),
    deps.repo.identity.getAppMembership(appScope(input.appId), input.actorId),
    deps.repo.identity.getEnvironment(appScope(input.appId), input.environmentId),
  ]);
  if (!orgMembership || !appMembership) return forbidden(requestId);
  if (!environment) return notFound("Environment not found", requestId);

  const scope = envScope(input.appId, input.environmentId);
  const [experimentRows, flagRows] = await Promise.all([
    deps.repo.experiments.listExperiments(scope),
    deps.repo.flags.flags.findMany(appScope(input.appId)),
  ]);
  const flags = new Map(flagRows.map((flag) => [flag.id, flag.name]));
  const items = await Promise.all(
    experimentRows.map(async (row): Promise<PanelExperimentListItem> => {
      const experiment = experimentResponse(row);
      const flagName = flags.get(experiment.flagId);
      if (!flagName) throw new Error(`Experiment ${experiment.id} references a missing Flag`);
      return {
        id: experiment.id,
        name: experiment.name,
        status: experiment.status,
        flag: { id: experiment.flagId, name: flagName },
        liveRunId: experiment.liveRunId,
        health: await runningHealth(deps.analysis, input.actorId, experiment),
      };
    }),
  );
  return Response.json({ items });
}

async function runningHealth(
  analysis: Fetcher,
  actorId: string,
  experiment: ReturnType<typeof experimentResponse>,
): Promise<PanelExperimentHealth | null> {
  if (experiment.status !== "running") return null;
  if (!experiment.liveRunId) {
    throw new Error(`Running Experiment ${experiment.id} has no live Run`);
  }
  const results = await parseScopedAnalysisResults(
    await analysis.fetch(
      scopedAnalysisResultsRequest({
        operation: "experiment_results_post",
        actorId,
        appId: experiment.appId,
        environmentId: experiment.environmentId,
        experimentId: experiment.id,
        runId: experiment.liveRunId,
      }),
    ),
  );
  return {
    significanceReached: results.arm_results.some(
      (result) => result.is_significant && result.in_bh_family && result.decision_valid,
    ),
    srmFiring:
      results.srm.srm_is_mismatch ||
      results.srm.activated_srm_mismatch === true ||
      results.health.activation_balance_mismatch === true,
    guardrailBreached: results.guardrail_results.some((result) => result.is_breached === true),
  };
}

function forbidden(requestId: string): Response {
  return renderError(
    { code: "FORBIDDEN", message: "live App membership is required", details: {} },
    { requestId },
  );
}

function notFound(message: string, requestId: string): Response {
  return renderError({ code: "APP_NOT_FOUND", message, details: {} }, { requestId });
}
