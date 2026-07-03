import { describe, expect, it } from "vitest";
import type { StatsInput } from "@splitch/contracts";
import { analyzeStats } from "./stats-engine.js";
import { ENGINE_RUN_ID, exposure } from "./stats-engine-test-helpers.js";

describe("StatsEngine.analyze zero-event Metrics", () => {
  it("emits ArmResults for a locked decision-family Metric before any Metric rows arrive", async () => {
    const output = await analyzeStats(zeroEventDecisionFamilyStatsInput());
    const control = armResult(output, "empty_conversion", "control");
    const treatment = armResult(output, "empty_conversion", "treatment");

    expect(control).toMatchObject({
      sample_size_n: 2,
      point_estimate: 0,
      relative_lift_pct: null,
      decision_valid: true,
      exploratory: false,
      status: "ready",
    });
    expect(treatment).toMatchObject({
      sample_size_n: 2,
      point_estimate: 0,
      relative_lift_pct: null,
      ci_lower: null,
      ci_upper: null,
      p_value: 1,
      is_significant: false,
      in_bh_family: true,
      decision_valid: true,
      exploratory: false,
      status: "insufficient_denominator",
    });
  });
});

function armResult(
  output: Awaited<ReturnType<typeof analyzeStats>>,
  metricId: string,
  variant: string,
) {
  const result = output.arm_results.find(
    (arm) => arm.metric_id === metricId && arm.variant === variant,
  );
  if (result === undefined) {
    throw new Error(`test fixture missing ${variant} result for ${metricId}`);
  }
  return result;
}

function zeroEventDecisionFamilyStatsInput(): StatsInput {
  return {
    run_id: ENGINE_RUN_ID,
    confidence_level: 0.95,
    horizon: "sequential",
    allocation: { control: 50, treatment: 50 },
    control_variant: "control",
    decision_family: [{ metric_id: "empty_conversion", variant: "treatment" }],
    guardrail_decisions: [],
    exposures: [
      exposure("control", "control_0"),
      exposure("control", "control_1"),
      exposure("treatment", "treatment_0"),
      exposure("treatment", "treatment_1"),
    ],
    metric_values: [],
  };
}
