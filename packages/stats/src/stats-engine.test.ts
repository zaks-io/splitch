import { describe, expect, it } from "vitest";
import type { StatsInput } from "@splitch/contracts";
import { analyzeStats } from "./stats-engine.js";
import { ENGINE_RUN_ID, binomialStatsInput, exposure } from "./stats-engine-test-helpers.js";

describe("StatsEngine.analyze", () => {
  it("returns a running infinite CI when either arm has N=0", async () => {
    const output = await analyzeStats(
      binomialStatsInput({
        controlN: 100,
        treatmentN: 0,
        controlConversions: 20,
        treatmentConversions: 0,
      }),
    );
    const treatment = treatmentResult(output);

    expect(treatment).toMatchObject({
      status: "running",
      sample_size_n: 0,
      relative_lift_pct: null,
      ci_lower: Number.NEGATIVE_INFINITY,
      ci_upper: Number.POSITIVE_INFINITY,
      p_value: 1,
      is_significant: false,
    });
  });

  it("surfaces low_n_warning without suppressing the result", async () => {
    const output = await analyzeStats(
      binomialStatsInput({
        controlN: 2,
        treatmentN: 2,
        controlConversions: 1,
        treatmentConversions: 2,
      }),
    );
    const treatment = treatmentResult(output);

    expect(output.health.low_n_warning).toBe(true);
    expect(treatment.sample_size_n).toBe(2);
    expect(treatment.status).toBe("ready");
  });

  it("turns divergent CI math into an error status instead of a finite corrupt CI", async () => {
    const input: StatsInput = {
      run_id: ENGINE_RUN_ID,
      confidence_level: 0.95,
      horizon: "sequential",
      allocation: { control: 50, treatment: 50 },
      control_variant: "control",
      decision_family: [{ metric_id: "huge_count", variant: "treatment" }],
      guardrail_decisions: [],
      exposures: [
        exposure("control", "control_0"),
        exposure("control", "control_1"),
        exposure("treatment", "treatment_0"),
        exposure("treatment", "treatment_1"),
      ],
      metric_values: [
        countRow("control_0", 1),
        countRow("control_1", 1),
        countRow("treatment_0", Number.MAX_VALUE),
        countRow("treatment_1", 1),
      ],
    };
    const output = await analyzeStats(input);
    const treatment = treatmentResult(output, "huge_count");

    expect(treatment.status).toBe("error");
    expect(treatment.ci_lower).toBe(Number.NEGATIVE_INFINITY);
    expect(treatment.ci_upper).toBe(Number.POSITIVE_INFINITY);
    expect(treatment.p_value).toBe(1);
    expect(Number.isFinite(treatment.ci_lower)).toBe(false);
    expect(Number.isFinite(treatment.ci_upper)).toBe(false);
  });

  it("does not produce fixed-horizon decision CIs before the locked sample size", async () => {
    const output = await analyzeStats(
      binomialStatsInput({
        controlN: 99,
        treatmentN: 99,
        controlConversions: 20,
        treatmentConversions: 40,
        horizon: "fixed",
        sampleSizeLocked: 100,
      }),
    );
    const treatment = treatmentResult(output);

    expect(treatment.status).toBe("running");
    expect(treatment.ci_lower).toBe(Number.NEGATIVE_INFINITY);
    expect(treatment.ci_upper).toBe(Number.POSITIVE_INFINITY);
    expect(treatment.p_value).toBe(1);
    expect(treatment.is_significant).toBe(false);
  });

  it("does not breach locked guardrails before fixed-horizon sample size is locked", async () => {
    const output = await analyzeStats(
      binomialStatsInput({
        controlN: 99,
        treatmentN: 99,
        controlConversions: 20,
        treatmentConversions: 40,
        horizon: "fixed",
        sampleSizeLocked: 100,
        includeGuardrail: true,
      }),
    );
    const guardrailArm = treatmentResult(output, "guardrail_conversion");

    expect(guardrailArm.status).toBe("running");
    expect(guardrailArm.ci_lower).toBe(Number.NEGATIVE_INFINITY);
    expect(output.guardrail_results).toEqual([
      {
        metric_id: "guardrail_conversion",
        variant: "treatment",
        ci_lower: Number.NEGATIVE_INFINITY,
        threshold: 10,
        is_breached: null,
        in_bh_family: false,
        exploratory: false,
        decision_valid: true,
        breach_reason: null,
      },
    ]);
  });

  it("rejects sample_size_locked on a sequential locked Run input", async () => {
    await expect(
      analyzeStats(
        binomialStatsInput({
          controlN: 100,
          treatmentN: 100,
          controlConversions: 20,
          treatmentConversions: 40,
          sampleSizeLocked: 100,
        }),
      ),
    ).rejects.toThrow(/sample_size_locked is only valid/);
  });
});

function treatmentResult(
  output: Awaited<ReturnType<typeof analyzeStats>>,
  metricId = "conversion",
) {
  const result = output.arm_results.find(
    (arm) => arm.metric_id === metricId && arm.variant === "treatment",
  );
  if (result === undefined) {
    throw new Error(`test fixture missing treatment result for ${metricId}`);
  }
  return result;
}

function countRow(targeting_key_hash: string, value: number) {
  return {
    targeting_key_hash,
    run_id: ENGINE_RUN_ID,
    metric_id: "huge_count",
    metric_type: "count",
    value,
    in_window: true,
  } satisfies StatsInput["metric_values"][number];
}
