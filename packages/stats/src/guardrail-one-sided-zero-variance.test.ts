import type { PerEntityMetricRow, StatsInput } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { evaluateOneSidedGuardrail } from "./guardrail-one-sided";
import { analyzeStats } from "./stats-engine";
import { ENGINE_RUN_ID, exposure } from "./stats-engine-test-helpers";

const N = 400;

describe("analysis-v2 Guardrail with a -100% margin and constant Treatment values", () => {
  it("returns undecided with no bounds instead of throwing on zero contrast variance", () => {
    const result = evaluateOneSidedGuardrail({
      treatmentEstimate: 0,
      controlEstimate: 10,
      treatmentVar: 0,
      controlVar: 0.0025,
      margin: -1,
      alpha: 0.05,
      n_t: N,
      n_c: N,
      target_n: 5_000,
      horizon: "sequential",
    });

    expect(result.verdict).toBe("undecided");
    expect(result.lower).toBeNull();
    expect(result.upper).toBeNull();
  });

  it.each(["sequential", "fixed"] as const)(
    "leaves the Guardrail unevaluated through analyzeStats (%s horizon)",
    async (horizon) => {
      const output = await analyzeStats(zeroTreatmentInput(horizon));

      expect(output.guardrail_results).toHaveLength(1);
      expect(output.guardrail_results[0]?.is_breached).toBeNull();
    },
  );
});

function zeroTreatmentInput(horizon: "sequential" | "fixed"): StatsInput {
  const controlIds = Array.from({ length: N }, (_unused, index) => `control_${index}`);
  const treatmentIds = Array.from({ length: N }, (_unused, index) => `treatment_${index}`);
  const metricRow = (id: string, value: number): PerEntityMetricRow => ({
    targeting_key_hash: id,
    run_id: ENGINE_RUN_ID,
    metric_id: "guardrail_count",
    metric_type: "count",
    value,
    in_window: true,
  });
  return {
    run_id: ENGINE_RUN_ID,
    analysis_version: "analysis-v2",
    confidence_level: 0.95,
    horizon,
    ...(horizon === "fixed" ? { sample_size_locked: 2 * N } : {}),
    allocation: { control: 50, treatment: 50 },
    control_variant: "control",
    decision_family: [],
    guardrail_decisions: [
      {
        metric_id: "guardrail_count",
        variant: "treatment",
        downside_threshold_pct: -100,
        guardrail_locked_at_run_start: true,
        threshold_locked_at_run_start: true,
      },
    ],
    metric_variance_config: [
      {
        metric_id: "guardrail_count",
        winsorize: false,
        winsorize_pct: 99,
        cuped: false,
        cuped_coverage_threshold_pct: 70,
      },
    ],
    exposures: [
      ...controlIds.map((id) => exposure("control", id)),
      ...treatmentIds.map((id) => exposure("treatment", id)),
    ],
    metric_values: [
      ...controlIds.map((id, index) => metricRow(id, index % 2 === 0 ? 9 : 11)),
      ...treatmentIds.map((id) => metricRow(id, 0)),
    ],
  };
}
