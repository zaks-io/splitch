import { lockedFamilyMembers } from "@splitch/contracts";
import {
  AnalysisResultsError,
  guardrailBreached,
  isAnalysisInsufficientData,
  isAnalysisResultsNoData,
  type PanelExperimentHealth,
  parseAnalysisResults,
  srmFiring,
} from "@splitch/control-plane-sdk/panel-experiments";
import type { PerformanceSpanRecorder } from "@splitch/observability/performance-spans";
import { fetchAnalysis } from "./analysis-binding";
import { analysisResultsRequest } from "./analysis-results-request";
import type { experimentResponse } from "./experiment-model";

export async function runningExperimentHealth(
  analysis: Fetcher,
  actorId: string,
  experiment: ReturnType<typeof experimentResponse>,
  spans?: PerformanceSpanRecorder,
): Promise<PanelExperimentHealth | null> {
  if (experiment.status !== "running") return null;
  if (!experiment.liveRunId) {
    throw new Error(`Running Experiment ${experiment.id} has no live Run`);
  }
  const response = await fetchAnalysis(
    analysis,
    analysisResultsRequest(
      {
        appId: experiment.appId,
        environmentId: experiment.environmentId,
        experimentId: experiment.id,
        runId: experiment.liveRunId,
      },
      actorId,
    ),
    "results_read",
    spans,
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
