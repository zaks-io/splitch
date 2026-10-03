import { describe, expect, it } from "vitest";
import type { DedupeExposureRow, PerEntityMetricRow, StatsInput } from "@splitch/contracts";
import { analyzeStats } from "./stats-engine";
import { ENGINE_RUN_ID, binomialStatsInput, exposure } from "./stats-engine-test-helpers";

describe("StatsEngine.analyze analysis_version dispatch", () => {
  it("dispatches sequential SRM under analysis-v2", async () => {
    const shared = {
      controlN: 900,
      treatmentN: 100,
      controlConversions: 90,
      treatmentConversions: 20,
    };
    const v1 = await analyzeStats(
      binomialStatsInput({ ...shared, analysisVersion: "analysis-v1" }),
    );
    const v2 = await analyzeStats(
      binomialStatsInput({ ...shared, analysisVersion: "analysis-v2" }),
    );

    expect(v1.srm.srm_is_mismatch).toBe(true);
    expect(v2.srm.srm_is_mismatch).toBe(true);
    expect(v2.srm.srm_p_value).not.toBe(v1.srm.srm_p_value);
  });

  it("keeps v1 Fieller Guardrail breach and switches v2 to one-sided contrast semantics", async () => {
    // Harmful Treatment on a locked relative Guardrail: v1 fires on Fieller
    // lower < threshold; v2 requires the one-sided upper contrast bound < 0.
    const shared = {
      controlN: 400,
      treatmentN: 400,
      controlConversions: 200,
      treatmentConversions: 80,
      includeGuardrail: true,
      horizon: "sequential" as const,
    };
    const v1 = await analyzeStats(
      binomialStatsInput({ ...shared, analysisVersion: "analysis-v1" }),
    );
    const v2 = await analyzeStats(
      binomialStatsInput({ ...shared, analysisVersion: "analysis-v2" }),
    );

    expect(v1.guardrail_results[0]?.is_breached).toBe(true);
    expect(v1.guardrail_results[0]?.breach_reason).toMatch(/CI lower bound/);
    expect(v2.guardrail_results[0]?.is_breached).toBe(true);
    expect(v2.guardrail_results[0]?.breach_reason).toMatch(
      /one-sided oriented contrast upper bound/,
    );
    // Reporting intervals on arm_results stay Fieller under both versions.
    const v1Arm = v1.arm_results.find(
      (arm) => arm.metric_id === "guardrail_conversion" && arm.variant === "treatment",
    );
    const v2Arm = v2.arm_results.find(
      (arm) => arm.metric_id === "guardrail_conversion" && arm.variant === "treatment",
    );
    expect(v2Arm?.ci_lower).toBe(v1Arm?.ci_lower);
    expect(v2Arm?.ci_upper).toBe(v1Arm?.ci_upper);
    // v2 Guardrail ci_lower is that Fieller report, not a contrast-derived relative bound.
    expect(v2.guardrail_results[0]?.ci_lower).toBe(v2Arm?.ci_lower);
  });

  it("orients analysis-v2 Guardrails by negative Control through analyzeStats", async () => {
    // C=-12, T=-9 → relative lift −25% vs −10% margin → breach when variance is tiny.
    const harmful = await analyzeStats(negativeControlGuardrailInput(-12, -9));
    expect(harmful.guardrail_results[0]?.is_breached).toBe(true);
    expect(
      harmful.arm_results.find((arm) => arm.variant === "treatment")?.relative_lift_pct,
    ).toBeCloseTo(-25, 8);

    // C=-12, T=-13 → relative lift +8.33% → safe at the same margin.
    const safe = await analyzeStats(negativeControlGuardrailInput(-12, -13));
    expect(safe.guardrail_results[0]?.is_breached).toBe(false);
    expect(
      safe.arm_results.find((arm) => arm.variant === "treatment")?.relative_lift_pct,
    ).toBeCloseTo(((-13 - -12) / -12) * 100, 8);
  });
});

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
      analysis_version: "analysis-v1",
      confidence_level: 0.95,
      horizon: "sequential",
      allocation: { control: 50, treatment: 50 },
      control_variant: "control",
      decision_family: [{ metric_id: "huge_count", variant: "treatment" }],
      guardrail_decisions: [],
      metric_variance_config: [],
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
        threshold: 35,
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

/**
 * Near-constant-per-arm count Metric with a locked relative Guardrail under
 * analysis-v2. Tiny within-arm noise keeps sampling variance positive while
 * leaving the relative-lift sign unambiguous.
 */
function negativeControlGuardrailInput(controlMean: number, treatmentMean: number): StatsInput {
  const n = 400;
  const controlIds = Array.from({ length: n }, (_unused, index) => `control_${index}`);
  const treatmentIds = Array.from({ length: n }, (_unused, index) => `treatment_${index}`);
  const exposures: DedupeExposureRow[] = [
    ...controlIds.map((id) => exposure("control", id)),
    ...treatmentIds.map((id) => exposure("treatment", id)),
  ];
  const metric_values: PerEntityMetricRow[] = [
    ...controlIds.map((id, index) => ({
      targeting_key_hash: id,
      run_id: ENGINE_RUN_ID,
      metric_id: "guardrail_count",
      metric_type: "count" as const,
      value: controlMean + (index % 2 === 0 ? 0.01 : -0.01),
      in_window: true,
    })),
    ...treatmentIds.map((id, index) => ({
      targeting_key_hash: id,
      run_id: ENGINE_RUN_ID,
      metric_id: "guardrail_count",
      metric_type: "count" as const,
      value: treatmentMean + (index % 2 === 0 ? 0.01 : -0.01),
      in_window: true,
    })),
  ];
  return {
    run_id: ENGINE_RUN_ID,
    analysis_version: "analysis-v2",
    confidence_level: 0.95,
    horizon: "sequential",
    allocation: { control: 50, treatment: 50 },
    control_variant: "control",
    decision_family: [],
    guardrail_decisions: [
      {
        metric_id: "guardrail_count",
        variant: "treatment",
        downside_threshold_pct: -10,
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
    exposures,
    metric_values,
  };
}
