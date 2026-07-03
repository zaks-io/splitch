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

describe("StatsEngine.analyze Activation gates", () => {
  it("uses only activated Entities as the metric denominator when Activation gate rows exist", async () => {
    const output = await analyzeStats(activationGatedStatsInput());
    const control = armResult(output, "conversion", "control");
    const treatment = treatmentResult(output);

    expect(control).toMatchObject({
      sample_size_n: 1,
      point_estimate: 1,
    });
    expect(treatment).toMatchObject({
      sample_size_n: 1,
      point_estimate: 1,
    });
    expect(output.srm.observed_counts).toEqual({ control: 2, treatment: 2 });
    expect(output.health.deduped_counts).toEqual({ control: 2, treatment: 2 });
    expect(output.health.activation_rates).toEqual({ control: 0.5, treatment: 0.5 });
  });
});

function treatmentResult(
  output: Awaited<ReturnType<typeof analyzeStats>>,
  metricId = "conversion",
) {
  return armResult(output, metricId, "treatment");
}

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

function activationGatedStatsInput(): StatsInput {
  const controlActivated = "control_activated";
  const controlUnactivated = "control_unactivated";
  const treatmentActivated = "treatment_activated";
  const treatmentUnactivated = "treatment_unactivated";

  return {
    run_id: ENGINE_RUN_ID,
    confidence_level: 0.95,
    horizon: "sequential",
    allocation: { control: 50, treatment: 50 },
    control_variant: "control",
    decision_family: [{ metric_id: "conversion", variant: "treatment" }],
    guardrail_decisions: [],
    exposures: [
      gatedExposure("control", controlActivated, ACTIVATION_TS),
      gatedExposure("control", controlUnactivated, FIRST_EXPOSURE_TS),
      gatedExposure("treatment", treatmentActivated, ACTIVATION_TS),
      gatedExposure("treatment", treatmentUnactivated, FIRST_EXPOSURE_TS),
    ],
    activation_rows: [
      activationRow(controlActivated, true),
      activationRow(controlUnactivated, false),
      activationRow(treatmentActivated, true),
      activationRow(treatmentUnactivated, false),
    ],
    metric_values: [
      binomialRow(controlActivated, 1),
      binomialRow(controlUnactivated, 0),
      binomialRow(treatmentActivated, 1),
      binomialRow(treatmentUnactivated, 0),
    ],
  };
}

const FIRST_EXPOSURE_TS = "2026-07-01T00:00:00.000Z";
const ACTIVATION_TS = "2026-07-01T00:05:00.000Z";

function gatedExposure(
  variant: string,
  targeting_key_hash: string,
  window_anchor: string,
): StatsInput["exposures"][number] {
  return {
    ...exposure(variant, targeting_key_hash),
    first_exposure_ts: FIRST_EXPOSURE_TS,
    window_anchor,
  };
}

function activationRow(
  targeting_key_hash: string,
  activated: boolean,
): NonNullable<StatsInput["activation_rows"]>[number] {
  return {
    targeting_key_hash,
    run_id: ENGINE_RUN_ID,
    activation_ts: ACTIVATION_TS,
    counterfactual: false,
    activated,
  };
}

function binomialRow(
  targeting_key_hash: string,
  value: number,
): StatsInput["metric_values"][number] {
  return {
    targeting_key_hash,
    run_id: ENGINE_RUN_ID,
    metric_id: "conversion",
    metric_type: "binomial",
    value,
    in_window: true,
  };
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
