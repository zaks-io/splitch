import {
  experimentSignificanceDisplays,
  experimentSrmDiagnostics,
  type ExperimentResultsResponse,
} from "@splitch/contracts";
import {
  type PanelExperimentListItem,
  type PanelExperimentResultsOutput,
  parseAnalysisResults,
} from "@splitch/control-plane-sdk/panel-experiments";
import { appScope, envScope, type Repository } from "@splitch/db";
import type { PerformanceSpanRecorder } from "@splitch/observability/performance-spans";
import { fetchAnalysis } from "./analysis-binding";
import { analysisResultsRequest } from "./analysis-results-request";
import {
  canConcludeWithRole,
  enrichAnalysisResultsResponse,
  produceNoRunResults,
} from "./experiment-results-enrich";
import { experimentNotFound, runNotFound } from "./experiment-errors";
import { runningExperimentHealth } from "./experiment-health";
import { experimentResponse, jsonArray, jsonObject } from "./experiment-model";
import { metricResponse } from "./metric-segment-shared";
import { panelScopeAccessError } from "./panel-scope-access";

interface PanelExperimentsDeps {
  repo: Repository;
  analysis: Fetcher;
  spans?: PerformanceSpanRecorder;
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
  const accessError = await panelScopeAccessError(deps.repo, input, requestId);
  if (accessError) return accessError;

  const scope = envScope(input.appId, input.environmentId);
  const [experimentRows, flagRows] = await Promise.all([
    deps.repo.experiments.listExperiments(scope),
    deps.repo.flags.flags.findMany(appScope(input.appId)),
  ]);
  const flags = new Map(flagRows.map((flag) => [flag.id, flag.name]));
  const draftExperimentIds = experimentRows
    .filter((row) => row.status === "draft")
    .map((row) => row.id);
  const experimentIdsWithRuns = new Set(
    draftExperimentIds.length > 0
      ? await deps.repo.experiments.listExperimentIdsWithRuns(scope, draftExperimentIds)
      : [],
  );
  const items = await Promise.all(
    experimentRows.map(async (row): Promise<PanelExperimentListItem> => {
      const experiment = experimentResponse(row);
      if (experiment.status === "archived") {
        throw new Error(`listExperiments returned archived Experiment ${experiment.id}`);
      }
      const flagName = flags.get(experiment.flagId);
      if (!flagName) throw new Error(`Experiment ${experiment.id} references a missing Flag`);
      return {
        id: experiment.id,
        key: experiment.key,
        name: experiment.name,
        status: experiment.status,
        flag: { id: experiment.flagId, name: flagName },
        liveRunId: experiment.liveRunId,
        // Ending a Run returns the Experiment to `draft`, so `draft` alone does
        // not mean "never ran" and cannot decide whether the Experiment belongs
        // in the creation flow. Counted only for drafts: every other status has
        // a Run by definition.
        hasRuns: experiment.status === "draft" ? experimentIdsWithRuns.has(experiment.id) : true,
        health: await runningExperimentHealth(deps.analysis, input.actorId, experiment, deps.spans),
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
  const accessError = await panelScopeAccessError(deps.repo, input, requestId);
  if (accessError) return accessError;

  const scope = envScope(input.appId, input.environmentId);
  const row = await deps.repo.experiments.getExperiment(scope, input.experimentId);
  if (!row) return experimentNotFound(requestId);
  const [flagRows, metricRows, variantRows, flagConfig, runRows] = await Promise.all([
    deps.repo.flags.flags.findMany(appScope(input.appId)),
    deps.repo.experiments.metrics.findMany(appScope(input.appId)),
    deps.repo.flags.listVariants(appScope(input.appId), row.flagId),
    deps.repo.flags.getFlagConfig(scope, row.flagId),
    deps.repo.experiments.listRunsForExperiment(scope, input.experimentId),
  ]);
  const flag = flagRows.find((candidate) => candidate.id === row.flagId);
  if (!flag) throw new Error(`Experiment ${row.id} references a missing Flag`);
  const eventDefinitions = await referencedEventDefinitions(deps.repo, input.appId, metricRows);

  return Response.json({
    experiment: {
      id: row.id,
      key: row.key,
      name: row.name,
      description: row.description ?? "",
      owner: row.owner ?? "",
      tags: jsonArray<string>(row.tags),
      status: row.status,
      flagId: row.flagId,
      targetingKey: row.targetingKeyField,
      targetingKeyType: row.targetingKeyType,
      activationMetricId: row.activationMetricId,
      conversionWindowMs: row.conversionWindowMs,
      // The decision-spec fields the Panel has to render, and render as LOCKED
      // once a Run froze them (ADR-0003). Leaving them off the projection would
      // leave the Panel with nothing to show but an editable-looking blank.
      confidenceLevel: row.confidenceLevel,
      dimensions: jsonArray<string>(row.dimensions),
      metricIds: metricIds(row.metrics),
      guardrailMetricIds: metricIds(row.guardrailMetrics),
      draftAllocation: jsonObject<Record<string, number>>(row.draftAllocation),
      draftSalt: row.draftSalt,
      draftTargetingRulesJson: row.draftTargetingRules,
      // A frozen Run stores resolved Targeting Rules, never the Segment
      // references they came from, so this staged list is the only place the
      // Panel can read what the next Run will resolve against.
      draftSegmentIds: jsonArray<string>(row.draftSegmentIds),
      liveRunId: row.liveRunId,
    },
    flag: { id: row.flagId, key: flag.key, name: flag.name },
    metrics: metricRows.map(metricResponse),
    eventDefinitions,
    variants: availableVariants(variantRows, flagConfig?.availableVariantNames ?? "[]"),
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
        activationMetricId: run.activationMetricId,
        salt: run.salt,
        allocation: jsonObject<Record<string, number>>(run.allocation) ?? {},
        controlVariantId: run.controlVariantId,
        variantsJson: run.variantSet,
        targetingRulesJson: run.targetingRules,
        targetN: run.targetN,
        decisionFamilyJson: run.decisionFamily,
        guardrailDecisionsJson: run.guardrailDecisions,
        metricVarianceConfigJson: run.metricVarianceConfig,
        decisionMetricIds: metricIds(run.decisionFamily),
        decisionGuardrailMetricIds: metricIds(run.guardrailDecisions),
        confidenceLevel: run.confidenceLevel,
        horizon: run.horizon,
        sampleSizeLocked: run.sampleSizeLocked,
        configHash: run.configHash,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        startReason: run.startReason,
        endReason: run.endReason,
        createdAt: run.createdAt,
      })),
  });
}

async function referencedEventDefinitions(
  repo: Repository,
  appId: string,
  metrics: Array<{ eventDefinitionId: string | null }>,
): Promise<Array<{ id: string; name: string }>> {
  const ids = [...new Set(metrics.flatMap(({ eventDefinitionId }) => eventDefinitionId ?? []))];
  const definitions = await repo.eventDefinitions.listDefinitionsByIds(appScope(appId), ids);
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  return ids.map((id) => {
    const definition = byId.get(id);
    if (!definition) throw new Error(`Metric references a missing Event Definition: ${id}`);
    return { id: definition.id, name: definition.name };
  });
}

/**
 * Results for exactly one Run, via the shared Control Plane result producer.
 *
 * The producer is a Worker invariant (ADR-0030 / plan 0.15): the Panel renders
 * its gate and readiness and never recomputes them, so the Panel, CLI, and MCP
 * skins cannot disagree.
 */
export async function panelExperimentResults(
  deps: PanelExperimentsDeps,
  input: PanelExperimentResultsRequestInput,
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const accessError = await panelScopeAccessError(deps.repo, input, requestId);
  if (accessError) return accessError;

  const scope = envScope(input.appId, input.environmentId);
  const [experiment, selectedRun, membership] = await Promise.all([
    deps.repo.experiments.getExperiment(scope, input.experimentId),
    input.runId
      ? deps.repo.experiments.getRun(scope, input.runId)
      : deps.repo.experiments.findLatestRunForExperiment(scope, input.experimentId),
    deps.repo.identity.getAppMembership(appScope(input.appId), input.actorId),
  ]);
  if (!experiment) return experimentNotFound(requestId);

  const run = selectedRun?.experimentId === input.experimentId ? selectedRun : null;
  // Draft Experiment: exists, never Started. Typed no_run (not RUN_NOT_FOUND /
  // EXPERIMENT_NOT_FOUND) so an agent is pointed at Start (SPL-305). A pinned
  // missing Run id is still RUN_NOT_FOUND — that is a different condition.
  if (!run) {
    if (input.runId !== undefined) return runNotFound(requestId);
    return Response.json(panelFromProducer(produceNoRunResults("detailed")));
  }

  const analysis = await parseAnalysisResults(
    await fetchAnalysis(
      deps.analysis,
      analysisResultsRequest(
        {
          appId: input.appId,
          environmentId: input.environmentId,
          experimentId: input.experimentId,
          runId: run.id,
        },
        input.actorId,
      ),
      "results_read",
      deps.spans,
    ),
    run.id,
  );

  const produced = enrichAnalysisResultsResponse(analysis, run, {
    view: "detailed",
    canConclude: canConcludeWithRole(membership?.role),
  });
  return Response.json(panelFromProducer(produced));
}

/**
 * Map the shared producer (public snake_case + readiness) onto the Panel's
 * camelCase projection. Visual treatment stays in the Panel; verdict math does not.
 */
function panelFromProducer(produced: ExperimentResultsResponse): PanelExperimentResultsOutput {
  const readiness = {
    readiness: produced.readiness,
    blockedBy: produced.blockedBy,
    reasons: produced.reasons,
  };
  if (produced.state === "no_run") {
    return { state: "no_run", ...readiness, recommendedAction: "START_A_RUN" };
  }
  if (produced.state === "no_data") {
    return {
      state: "no_data",
      runId: produced.run_id,
      runNumber: produced.run_number,
      runStatus: produced.run_status,
      control: produced.control,
      ...readiness,
      missing: produced.missing,
    };
  }
  if (produced.view !== "detailed") {
    throw new Error("panel Experiment Results requires the detailed producer view");
  }
  const ready = {
    state: "ready" as const,
    runId: produced.run_id,
    runNumber: produced.run_number,
    runStatus: produced.run_status,
    control: produced.control,
    ...readiness,
    stats: produced.stats,
    srm: experimentSrmDiagnostics(produced.stats, produced.srm_root_cause ?? null),
    gate: produced.gate,
    significance: experimentSignificanceDisplays(produced.stats),
  };
  return produced.data_watermark && produced.result_token
    ? {
        ...ready,
        dataWatermark: produced.data_watermark,
        resultToken: produced.result_token,
      }
    : ready;
}

/**
 * `decision_family` freezes as `MetricRef[]`, `guardrail_decisions` as
 * `GuardrailDecision[]` (snake_case, one entry per treatment Variant). The Panel
 * wants the Metric identity out of either, listed once each.
 */
function metricIds(raw: string): string[] {
  const ids = jsonArray<{ metricId?: string; metric_id?: string }>(raw).map((entry) => {
    const id = entry.metricId ?? entry.metric_id;
    if (!id) throw new Error("Run decision entry carries no Metric id");
    return id;
  });
  return [...new Set(ids)];
}

function availableVariants(
  variants: Array<{ id: string; name: string }>,
  availableVariantNames: string,
) {
  const available = new Set(jsonArray<string>(availableVariantNames));
  return variants
    .filter((variant) => available.has(variant.name))
    .map((variant) => ({ id: variant.id, name: variant.name }));
}
