import {
  experimentSignificanceDisplays,
  experimentSrmDiagnostics,
  type ExperimentResultsResponse,
} from "@splitch/contracts";
import type { PanelExperimentResultsOutput } from "@splitch/control-plane-sdk/panel-experiments";

/**
 * Map the shared producer (public snake_case + readiness) onto the Panel's
 * camelCase projection. Visual treatment stays in the Panel; verdict math does not.
 */
export function panelFromProducer(
  produced: ExperimentResultsResponse,
): PanelExperimentResultsOutput {
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
    ...(produced.recommendation !== undefined
      ? { recommendation: produced.recommendation }
      : { recommendationUnavailable: produced.recommendationUnavailable }),
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
