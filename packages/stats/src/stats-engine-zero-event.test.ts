import { describe, expect, it } from "vitest";
import type { StatsInput } from "@splitch/contracts";
import { analyzeStats } from "./stats-engine";
import { ENGINE_RUN_ID, binomialStatsInput, exposure } from "./stats-engine-test-helpers";

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

  it("keeps a total-loss Treatment decision-valid and breaches its locked relative guardrail", async () => {
    const output = await analyzeStats(
      binomialStatsInput({
        controlN: 100,
        treatmentN: 100,
        controlConversions: 40,
        treatmentConversions: 0,
        horizon: "fixed",
        sampleSizeLocked: 100,
        includeGuardrail: true,
      }),
    );
    const treatment = armResult(output, "conversion", "treatment");

    expect(treatment).toMatchObject({
      relative_lift_pct: -100,
      status: "ready",
      decision_valid: true,
      in_bh_family: true,
    });
    expect(treatment.ci_lower).toBeLessThan(-100);
    expect(treatment.ci_upper).toBeLessThan(0);
    expect(treatment.p_value).toBeLessThan(0.000001);
    expect(output.guardrail_results).toContainEqual(
      expect.objectContaining({
        metric_id: "guardrail_conversion",
        variant: "treatment",
        is_breached: true,
      }),
    );
  });

  it("uses a finite boundary-safe decision path for opposing all-event arms", async () => {
    const output = await analyzeStats(
      binomialStatsInput({
        controlN: 100,
        treatmentN: 100,
        controlConversions: 100,
        treatmentConversions: 0,
        horizon: "fixed",
        sampleSizeLocked: 100,
        includeGuardrail: true,
      }),
    );
    const treatment = armResult(output, "conversion", "treatment");

    expect(treatment).toMatchObject({
      relative_lift_pct: -100,
      status: "ready",
      decision_valid: true,
    });
    expect(treatment.ci_lower).toBeLessThan(-100);
    expect(treatment.p_value).toBeGreaterThan(0);
    expect(treatment.p_value).toBeLessThan(0.000001);
    expect(output.guardrail_results[0]).toMatchObject({ is_breached: true });
  });

  it("keeps absolute decision evidence when the Control makes no events", async () => {
    const output = await analyzeStats(
      binomialStatsInput({
        controlN: 100,
        treatmentN: 100,
        controlConversions: 0,
        treatmentConversions: 100,
        horizon: "fixed",
        sampleSizeLocked: 100,
      }),
    );
    const treatment = armResult(output, "conversion", "treatment");

    expect(treatment).toMatchObject({
      relative_lift_pct: null,
      ci_lower: null,
      ci_upper: null,
      status: "ready",
      decision_valid: true,
      in_bh_family: true,
      is_significant: true,
    });
    expect(treatment.p_value).toBeGreaterThan(0);
    expect(treatment.p_value).toBeLessThan(0.000001);
  });

  it("leaves a Guardrail unevaluated rather than breached when the Control mean is zero", async () => {
    const output = await analyzeStats(
      binomialStatsInput({
        controlN: 100,
        treatmentN: 100,
        controlConversions: 0,
        treatmentConversions: 100,
        horizon: "fixed",
        sampleSizeLocked: 100,
        includeGuardrail: true,
      }),
    );

    expect(output.guardrail_results[0]).toMatchObject({
      metric_id: "guardrail_conversion",
      variant: "treatment",
      ci_lower: null,
      is_breached: null,
      breach_reason: null,
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
    metric_variance_config: [],
    exposures: [
      exposure("control", "control_0"),
      exposure("control", "control_1"),
      exposure("treatment", "treatment_0"),
      exposure("treatment", "treatment_1"),
    ],
    metric_values: [],
  };
}
