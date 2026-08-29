import {
  evaluateExperimentDecisionGate,
  experimentSignificanceDisplays,
  experimentSrmDiagnostics,
  lockedFamilyMembers,
  resolveAnalysisControlIntegrity,
  resolveFrozenControlIdentity,
} from "@splitch/contracts";
import {
  AnalysisResultsError,
  guardrailBreached,
  isAnalysisInsufficientData,
  isAnalysisResultsNoData,
  type PanelExperimentHealth,
  type PanelExperimentListItem,
  type PanelExperimentResultsOutput,
  parseAnalysisResults,
  srmFiring,
} from "@splitch/control-plane-sdk/panel-experiments";
import { appScope, envScope, type Repository } from "@splitch/db";
import { analysisResultsRequest } from "./analysis-results-request";
import { experimentNotFound, runNotFound } from "./experiment-errors";
import { experimentResponse, jsonArray, jsonObject } from "./experiment-model";
import { metricResponse } from "./metric-segment-shared";
import { panelScopeAccessError } from "./panel-scope-access";

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
  const accessError = await panelScopeAccessError(deps.repo, input, requestId);
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
      if (experiment.status === "archived") {
        throw new Error(`listExperiments returned archived Experiment ${experiment.id}`);
      }
      const flagName = flags.get(experiment.flagId);
      if (!flagName) throw new Error(`Experiment ${experiment.id} references a missing Flag`);
      return {
        id: experiment.id,
        name: experiment.name,
        status: experiment.status,
        flag: { id: experiment.flagId, name: flagName },
        liveRunId: experiment.liveRunId,
        // Ending a Run returns the Experiment to `draft`, so `draft` alone does
        // not mean "never ran" and cannot decide whether the Experiment belongs
        // in the creation flow. Counted only for drafts: every other status has
        // a Run by definition.
        hasRuns:
          experiment.status === "draft"
            ? (await deps.repo.experiments.countRunsForExperiment(scope, experiment.id)) > 0
            : true,
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
  return Promise.all(
    ids.map(async (id) => {
      const definition = await repo.eventDefinitions.get(appScope(appId), id);
      if (!definition) throw new Error(`Metric references a missing Event Definition: ${id}`);
      return { id: definition.id, name: definition.name };
    }),
  );
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
  const accessError = await panelScopeAccessError(deps.repo, input, requestId);
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
  // Draft Experiment: exists, never Started. Typed no_run (not RUN_NOT_FOUND /
  // EXPERIMENT_NOT_FOUND) so an agent is pointed at Start (SPL-305). A pinned
  // missing Run id is still RUN_NOT_FOUND — that is a different condition.
  if (!run) {
    if (input.runId !== undefined) return runNotFound(requestId);
    const output: PanelExperimentResultsOutput = {
      state: "no_run",
      recommendedAction: "START_A_RUN",
    };
    return Response.json(output);
  }

  const results = await parseAnalysisResults(
    await deps.analysis.fetch(
      analysisResultsRequest(
        {
          appId: input.appId,
          environmentId: input.environmentId,
          experimentId: input.experimentId,
          runId: run.id,
        },
        input.actorId,
      ),
    ),
    run.id,
  );

  // Provenance, not current configuration: the baseline comes from the Run's own
  // immutable control_variant_id resolved inside the Variant set that same Run
  // froze (SPL-184, ADR-0002). Reading the Experiment's default Variant here
  // instead would relabel a historical Run's arms whenever somebody edits it.
  // The Analysis envelope carries its own control_variant from the Run Snapshot
  // written at Start (ADR-0047). It cannot relabel the frozen Run, but disagreement
  // is an integrity failure because the statistics may use a different Control.
  const control = resolveAnalysisControlIntegrity(
    resolveFrozenControlIdentity(run.controlVariantId, run.variantSet),
    results.control_variant,
  );
  const runStatus = run.status === "ended" ? ("ended" as const) : ("running" as const);
  if (isAnalysisResultsNoData(results)) {
    const output: PanelExperimentResultsOutput = {
      state: "no_data",
      runId: run.id,
      runNumber: run.runNumber,
      runStatus,
      control,
      missing: results.missing,
    };
    return Response.json(output);
  }
  const stats = results.stats;
  const output: PanelExperimentResultsOutput = {
    state: "ready",
    runId: run.id,
    runNumber: run.runNumber,
    runStatus,
    control,
    stats,
    srm: experimentSrmDiagnostics(stats),
    gate: evaluateExperimentDecisionGate(stats, control),
    significance: experimentSignificanceDisplays(stats),
  };
  return Response.json(output);
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

async function runningHealth(
  analysis: Fetcher,
  actorId: string,
  experiment: ReturnType<typeof experimentResponse>,
): Promise<PanelExperimentHealth | null> {
  if (experiment.status !== "running") return null;
  if (!experiment.liveRunId) {
    throw new Error(`Running Experiment ${experiment.id} has no live Run`);
  }
  const response = await analysis.fetch(
    analysisResultsRequest(
      {
        appId: experiment.appId,
        environmentId: experiment.environmentId,
        experimentId: experiment.id,
        runId: experiment.liveRunId,
      },
      actorId,
    ),
  );
  // A Run that has just Started has no rows in Analysis yet, and Analysis says so
  // with RUN_NOT_FOUND. That is the Run's first state, not a fault: reporting it
  // as one would take the whole Experiment list down for every Environment with a
  // freshly Started Run. Every other refusal still propagates, because a health
  // signal that swallows an unreadable result is worse than no list at all.
  const collecting = { significanceReached: false, srmFiring: false, guardrailBreached: false };
  const results = await parseAnalysisResults(response, experiment.liveRunId).catch(
    (cause: unknown) => {
      if (cause instanceof AnalysisResultsError && cause.code === "RUN_NOT_FOUND") return null;
      // Legacy Analysis builds used VALIDATION_ERROR for early-Run missing
      // inputs; current builds answer 200 `no_data` (handled below).
      if (cause instanceof AnalysisResultsError && isAnalysisInsufficientData(cause)) return null;
      throw cause;
    },
  );
  if (!results || isAnalysisResultsNoData(results)) return collecting;
  const stats = results.stats;
  return {
    // The same family the gate reads, so list health cannot call a Run
    // "Collecting data" while the gate is ready to ship it on a Primary
    // Dimension slice.
    significanceReached: lockedFamilyMembers(stats).some((member) => member.result.is_significant),
    srmFiring: srmFiring(stats),
    guardrailBreached: guardrailBreached(stats),
  };
}
