import type {
  ArmResult,
  CupedCovariateRow,
  MetricKind,
  PerEntityMetricRow,
  StatsInput,
} from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { analyzeStats } from "./stats-engine";
import { ENGINE_RUN_ID, binomialStatsInput, exposure } from "./stats-engine-test-helpers";

// Pooled over 20 Entities, the 90th-percentile cap is the 18th smallest value:
// 10. Only the Treatment whale (1000) sits above it.
const CONTROL_VALUES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const TREATMENT_VALUES = [2, 3, 4, 5, 6, 7, 8, 9, 10, 1000];

describe("estimand disclosure golden fixtures", () => {
  it("names a capped additive mean and discloses the uncapped estimate beside it", async () => {
    const output = await analyzeStats(revenueInput({ winsorize: true }));
    const control = arm(output.arm_results, "control");
    const treatment = arm(output.arm_results, "treatment");

    expect(control.point_estimate).toBe(5.5);
    expect(treatment.point_estimate).toBe(6.4);
    expect(control.estimand).toMatchObject({
      label: "capped_additive_mean",
      decision_label: "capped_additive_mean",
      capped_entity_count: 0,
      uncapped: { label: "uncapped_additive_mean", point_estimate: 5.5, cuped_applied: false },
    });
    expect(treatment.estimand).toMatchObject({
      label: "capped_additive_mean",
      decision_label: "capped_additive_mean",
      capped_entity_count: 1,
      uncapped: { label: "uncapped_additive_mean", point_estimate: 105.4, cuped_applied: false },
    });
    expect(treatment.estimand?.uncapped?.relative_lift_pct).toBeCloseTo((105.4 / 5.5 - 1) * 100, 9);
    expect(treatment.decision_valid).toBe(true);
  });

  it("matches the uncapped estimate to the same Run analyzed with winsorization off", async () => {
    const capped = await analyzeStats(revenueInput({ winsorize: true }));
    const uncapped = await analyzeStats(revenueInput({ winsorize: false }));
    const treatment = arm(uncapped.arm_results, "treatment");

    expect(treatment.estimand).toEqual({
      label: "uncapped_additive_mean",
      decision_label: "uncapped_additive_mean",
      capped_entity_count: null,
      uncapped: null,
    });
    expect(arm(capped.arm_results, "treatment").estimand?.uncapped).toEqual(
      uncappedView(treatment),
    );
  });

  it("keeps the selected CUPED covariate on the uncapped estimate", async () => {
    const covariates = [
      ...preperiod("control", CONTROL_VALUES),
      ...preperiod("treatment", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    ];
    const capped = await analyzeStats(revenueInput({ winsorize: true, covariates }));
    const uncapped = await analyzeStats(revenueInput({ winsorize: false, covariates }));
    const cappedTreatment = arm(capped.arm_results, "treatment");

    expect(cappedTreatment.variance_techniques.cuped_method).toBe("pre_period");
    expect(cappedTreatment.estimand?.uncapped?.cuped_applied).toBe(true);
    expect(cappedTreatment.estimand?.uncapped).toEqual(
      uncappedView(arm(uncapped.arm_results, "treatment")),
    );
  });

  it("names a ratio of capped component means and counts each capped Entity once", async () => {
    const output = await analyzeStats(ratioInput({ winsorize: true }));
    const uncapped = await analyzeStats(ratioInput({ winsorize: false }));
    const treatment = arm(output.arm_results, "treatment");

    expect(treatment.variance_techniques.winsorize_cap).toEqual({ num_value: 10, denom_value: 2 });
    expect(treatment.estimand).toMatchObject({
      label: "ratio_of_capped_means",
      decision_label: "ratio_of_capped_means",
      capped_entity_count: 1,
      uncapped: { label: "ratio_of_uncapped_means", cuped_applied: false },
    });
    expect(arm(output.arm_results, "control").estimand?.capped_entity_count).toBe(0);
    expect(treatment.estimand?.uncapped).toEqual(
      uncappedView(arm(uncapped.arm_results, "treatment")),
    );
    expect(arm(uncapped.arm_results, "treatment").estimand?.label).toBe("ratio_of_uncapped_means");
  });

  it("names a Binomial mean and never discloses a cap", async () => {
    const input = binomialStatsInput({
      controlN: 100,
      treatmentN: 100,
      controlConversions: 20,
      treatmentConversions: 40,
    });
    const output = await analyzeStats({
      ...input,
      metric_variance_config: [varianceConfig("conversion", true)],
    });

    for (const result of output.arm_results) {
      expect(result.variance_techniques.winsorized).toBe(false);
      expect(result.estimand).toEqual({
        label: "binomial_mean",
        decision_label: "binomial_mean",
        capped_entity_count: null,
        uncapped: null,
      });
    }
  });
});

function uncappedView(result: ArmResult) {
  return {
    label: result.estimand?.label,
    point_estimate: result.point_estimate,
    relative_lift_pct: result.relative_lift_pct,
    ci_lower: result.ci_lower,
    ci_upper: result.ci_upper,
    p_value: result.p_value,
    status: result.status,
    cuped_applied: result.variance_techniques.cuped_applied,
  };
}

function arm(results: readonly ArmResult[], variant: string): ArmResult {
  const result = results.find((candidate) => candidate.variant === variant);
  if (result === undefined) {
    throw new Error(`no arm result for ${variant}`);
  }
  return result;
}

function revenueInput(options: {
  readonly winsorize: boolean;
  readonly covariates?: readonly CupedCovariateRow[];
}): StatsInput {
  return engineInput(
    "revenue",
    options.winsorize,
    [
      ...rows("revenue", "control", CONTROL_VALUES),
      ...rows("revenue", "treatment", TREATMENT_VALUES),
    ],
    options.covariates,
  );
}

function ratioInput(options: { readonly winsorize: boolean }): StatsInput {
  // Treatment's last Entity exceeds both the numerator cap (10) and the
  // denominator cap (2), and still counts as one capped Entity.
  const denoms = [1, 1, 1, 1, 1, 2, 2, 2, 2, 2];
  return engineInput("ratio", options.winsorize, [
    ...rows("ratio", "control", CONTROL_VALUES, denoms),
    ...rows("ratio", "treatment", TREATMENT_VALUES, [...denoms.slice(0, 9), 9]),
  ]);
}

function engineInput(
  metricId: MetricKind,
  winsorize: boolean,
  metricValues: PerEntityMetricRow[],
  covariates: readonly CupedCovariateRow[] = [],
): StatsInput {
  return {
    run_id: ENGINE_RUN_ID,
    confidence_level: 0.95,
    horizon: "sequential",
    allocation: { control: 50, treatment: 50 },
    control_variant: "control",
    decision_family: [{ metric_id: metricId, variant: "treatment" }],
    guardrail_decisions: [],
    metric_variance_config: [varianceConfig(metricId, winsorize)],
    exposures: ["control", "treatment"].flatMap((variant) =>
      CONTROL_VALUES.map((_value, index) => exposure(variant, `${variant}_${index}`)),
    ),
    metric_values: metricValues,
    pre_period_covariates: [...covariates],
  };
}

function varianceConfig(metricId: string, winsorize: boolean) {
  return {
    metric_id: metricId,
    winsorize,
    winsorize_pct: 90,
    cuped: true,
    cuped_coverage_threshold_pct: 70,
  };
}

function rows(
  metricId: MetricKind,
  variant: string,
  values: readonly number[],
  denoms?: readonly number[],
): PerEntityMetricRow[] {
  return values.map((value, index) => ({
    targeting_key_hash: `${variant}_${index}`,
    run_id: ENGINE_RUN_ID,
    metric_id: metricId,
    metric_type: metricId,
    value,
    ...(denoms === undefined ? {} : { num_value: value, denom_value: denoms[index] ?? 0 }),
    in_window: true,
  }));
}

function preperiod(variant: string, values: readonly number[]): CupedCovariateRow[] {
  return values.map((value, index) => ({
    targeting_key_hash: `${variant}_${index}`,
    metric_id: "revenue",
    pre_period_value: value,
    covariate_source: "pre_period",
  }));
}
