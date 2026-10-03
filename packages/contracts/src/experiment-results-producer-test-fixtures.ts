import { reachedDuration, stats } from "./experiment-decision-gate-test-fixtures";
import type { AnalysisResultsEnvelope } from "./stats-result-contract";

export const control = {
  state: "frozen" as const,
  variantId: "variant_control",
  variant: "control",
};

export const run = {
  runNumber: 2,
  runStatus: "running" as const,
  control,
  duration: reachedDuration(),
};

export function readyAnalysis(
  overrides: Partial<Extract<AnalysisResultsEnvelope, { state: "ready" }>> = {},
): Extract<AnalysisResultsEnvelope, { state: "ready" }> {
  return {
    state: "ready",
    run_id: "run_1",
    control_variant: "control",
    data_watermark: "2026-07-08T00:00:00.000Z",
    result_token: `sha256:${"a".repeat(64)}`,
    stats: stats(),
    ...overrides,
  };
}
