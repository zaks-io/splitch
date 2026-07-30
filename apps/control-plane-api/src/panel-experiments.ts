import { evaluateExperimentDecisionGate, experimentSrmDiagnostics } from "@splitch/contracts";
import {
  type PanelExperimentHealth,
  type PanelExperimentListItem,
  type PanelExperimentResultsOutput,
  parseScopedAnalysisResults,
  scopedAnalysisResultsRequest,
} from "@splitch/control-plane-sdk/panel-experiments";
import { appScope, envScope, type Repository } from "@splitch/db";
import { renderError } from "@splitch/worker-runtime";
import { experimentNotFound, runNotFound } from "./experiment-errors";
import { experimentResponse, jsonArray, jsonObject } from "./experiment-model";

interface PanelExperimentsDeps {
  repo: Repository;
  analysis: Fetcher;
}

interface PanelExperimentsInput {
  actorId: string;
  appId: string;
  environmentId: string;
}

interface PanelExperimentDetailInput extends PanelExperimentsInput {
  experimentId: string;
}

interface PanelExperimentResultsRequestInput extends PanelExperimentDetailInput {
  runId?: string;
}

export async function panelExperimentsList(
  deps: PanelExperimentsDeps,
  input: PanelExperimentsInput,
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const accessError = await panelAccessError(deps.repo, input, requestId);
  if (accessError) return accessError;

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

export async function panelExperimentDetail(
  deps: Pick<PanelExperimentsDeps, "repo">,
  input: PanelExperimentDetailInput,
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const accessError = await panelAccessError(deps.repo, input, requestId);
  if (accessError) return accessError;

  const scope = envScope(input.appId, input.environmentId);
  const [row, flagRows, runRows] = await Promise.all([
    deps.repo.experiments.getExperiment(scope, input.experimentId),
    deps.repo.flags.flags.findMany(appScope(input.appId)),
    deps.repo.experiments.listRunsForExperiment(scope, input.experimentId),
  ]);
  if (!row) return experimentNotFound(requestId);
  const flagName = flagRows.find((flag) => flag.id === row.flagId)?.name;
  if (!flagName) throw new Error(`Experiment ${row.id} references a missing Flag`);

  return Response.json({
    experiment: {
      id: row.id,
      name: row.name,
      status: row.status,
      flagId: row.flagId,
      liveRunId: row.liveRunId,
    },
    flag: { id: row.flagId, name: flagName },
    runs: runRows
      .sort((left, right) => right.runNumber - left.runNumber)
      .map((run) => ({
        id: run.id,
        experimentId: run.experimentId,
        environmentId: run.environmentId,
        runNumber: run.runNumber,
        status: run.status,
        targetingKey: run.targetingKeyField,
        targetingKeyType: run.targetingKeyType,
        salt: run.salt,
        allocation: jsonObject<Record<string, number>>(run.allocation) ?? {},
        controlVariantId: run.controlVariantId,
        variantsJson: run.variantSet,
        targetingRulesJson: run.targetingRules,
        configHash: run.configHash,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        startReason: run.startReason,
        endReason: run.endReason,
        createdAt: run.createdAt,
      })),
  });
}

/**
 * Results for exactly one Run, with the ship-decision gate evaluated here.
 *
 * The gate is a Worker invariant (ADR-0030): the Panel renders this refusal and
 * never recomputes it, so the Panel, CLI, and MCP skins cannot disagree.
 */
export async function panelExperimentResults(
  deps: PanelExperimentsDeps,
  input: PanelExperimentResultsRequestInput,
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const accessError = await panelAccessError(deps.repo, input, requestId);
  if (accessError) return accessError;

  const scope = envScope(input.appId, input.environmentId);
  const experiment = await deps.repo.experiments.getExperiment(scope, input.experimentId);
  if (!experiment) return experimentNotFound(requestId);

  const runs = await deps.repo.experiments.listRunsForExperiment(scope, input.experimentId);
  const run = input.runId
    ? runs.find((candidate) => candidate.id === input.runId)
    : runs.reduce<(typeof runs)[number] | undefined>(
        (latest, candidate) =>
          latest && latest.runNumber > candidate.runNumber ? latest : candidate,
        undefined,
      );
  if (!run) return runNotFound(requestId);

  const stats = await parseScopedAnalysisResults(
    await deps.analysis.fetch(
      scopedAnalysisResultsRequest({
        operation: "experiment_results_post",
        actorId: input.actorId,
        appId: input.appId,
        environmentId: input.environmentId,
        experimentId: input.experimentId,
        runId: run.id,
      }),
    ),
  );

  const output: PanelExperimentResultsOutput = {
    runId: run.id,
    runNumber: run.runNumber,
    runStatus: run.status === "ended" ? "ended" : "running",
    controlVariant: controlVariantName(run.variantSet, experiment.defaultVariantId, run.id),
    stats,
    srm: experimentSrmDiagnostics(stats),
    gate: evaluateExperimentDecisionGate(stats),
  };
  return Response.json(output);
}

/** The Run's frozen baseline Variant. Every reported lift is measured against it. */
function controlVariantName(
  variantSetJson: string,
  defaultVariantId: string | null,
  runId: string,
): string {
  const variants = jsonArray<{ id: string; name: string }>(variantSetJson);
  const control = variants.find((variant) => variant.id === defaultVariantId);
  if (!control) throw new Error(`Run ${runId} has no Variant matching its default Variant`);
  return control.name;
}

async function panelAccessError(
  repo: Repository,
  input: PanelExperimentsInput,
  requestId: string,
): Promise<Response | null> {
  const app = await repo.identity.getApp(input.appId);
  if (!app) return notFound("App not found", requestId);
  const [orgMembership, appMembership, environment] = await Promise.all([
    repo.identity.getOrgMembership(app.organizationId, input.actorId),
    repo.identity.getAppMembership(appScope(input.appId), input.actorId),
    repo.identity.getEnvironment(appScope(input.appId), input.environmentId),
  ]);
  if (!orgMembership || !appMembership) return forbidden(requestId);
  return environment ? null : notFound("Environment not found", requestId);
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
