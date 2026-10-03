import type {
  CupedCovariateRow,
  DedupeExposureRow,
  PerEntityMetricRow,
  StatsInput,
} from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { contrastKey, estimateGuardrailContrasts } from "./guardrail-contrasts";
import { estimateMetricComparison, estimateMetricComparisons } from "./variance-estimators";

const RUN_ID = "run_guardrail_contrasts";
const ENGINE_TS = "2026-07-01T00:00:00.000Z";

describe("estimateGuardrailContrasts multi-Variant pooling", () => {
  it("reuses the all-arm winsorization cap so Control+A alone cannot soften a -10% guardrail", () => {
    // Codex fixture: C=[1,10,10], A=[3,3,3], B=[100,100,100] at 50% winsorize.
    // All-arm cap is 10 (C=7, A=3); pair-only C+A caps at 3 (C=7/3, A=3) and
    // would look like a lift above a -10% margin against a published estimand
    // that is far below it.
    const input = multiArmCountInput({
      control: [1, 10, 10],
      treatment_a: [3, 3, 3],
      treatment_b: [100, 100, 100],
      winsorize_pct: 50,
      cuped: false,
    });
    const exposures = input.exposures;
    const contrasts = estimateGuardrailContrasts(input, exposures);
    const comparison = contrasts.get(contrastKey("revenue", "treatment_a"));
    const pooled = estimateMetricComparisons({
      run_id: RUN_ID,
      metric_id: "revenue",
      metric_type: "count",
      control_variant: "control",
      treatment_variants: ["treatment_a", "treatment_b"],
      exposures,
      metric_values: input.metric_values,
      winsorize: true,
      winsorize_pct: 50,
      cuped: false,
    }).comparisons.find((candidate) => candidate.treatment.variant === "treatment_a");
    const pairOnly = estimateMetricComparison({
      run_id: RUN_ID,
      metric_id: "revenue",
      metric_type: "count",
      control_variant: "control",
      treatment_variant: "treatment_a",
      exposures,
      metric_values: input.metric_values,
      winsorize: true,
      winsorize_pct: 50,
      cuped: false,
    });

    expect(comparison?.variance_techniques.winsorize_cap).toBe(10);
    expect(comparison?.control.point_estimate).toBe(7);
    expect(comparison?.treatment.point_estimate).toBe(3);
    expect(comparison).toEqual(pooled);
    expect(pairOnly.variance_techniques.winsorize_cap).toBe(3);
    expect(pairOnly.control.point_estimate).toBeCloseTo(7 / 3, 15);
    expect(pairOnly.control.point_estimate).not.toBe(comparison?.control.point_estimate);
  });

  it("fits CUPED across every allocated arm, not Control+guardrail Treatment alone", () => {
    // Strong pre-period on treatment_b shifts the pooled slope away from the
    // pair-only (control, treatment_a) fit.
    const controlValues = [10, 12, 14, 16];
    const treatmentAValues = [11, 13, 15, 17];
    const treatmentBValues = [40, 50, 60, 70];
    const controlCov = [1, 2, 3, 4];
    const treatmentACov = [1, 2, 3, 4];
    const treatmentBCov = [20, 25, 30, 35];
    const input = multiArmCountInput({
      control: controlValues,
      treatment_a: treatmentAValues,
      treatment_b: treatmentBValues,
      winsorize_pct: 100,
      cuped: true,
      covariates: [
        ...prePeriodRows("control", controlCov),
        ...prePeriodRows("treatment_a", treatmentACov),
        ...prePeriodRows("treatment_b", treatmentBCov),
      ],
    });
    const exposures = input.exposures;
    const contrasts = estimateGuardrailContrasts(input, exposures);
    const comparison = contrasts.get(contrastKey("revenue", "treatment_a"));
    const pooled = estimateMetricComparisons({
      run_id: RUN_ID,
      metric_id: "revenue",
      metric_type: "count",
      control_variant: "control",
      treatment_variants: ["treatment_a", "treatment_b"],
      exposures,
      metric_values: input.metric_values,
      pre_period_covariates: input.pre_period_covariates,
      winsorize: false,
      cuped: true,
    }).comparisons.find((candidate) => candidate.treatment.variant === "treatment_a");
    const pairOnly = estimateMetricComparison({
      run_id: RUN_ID,
      metric_id: "revenue",
      metric_type: "count",
      control_variant: "control",
      treatment_variant: "treatment_a",
      exposures,
      metric_values: input.metric_values,
      pre_period_covariates: input.pre_period_covariates,
      winsorize: false,
      cuped: true,
    });

    expect(comparison?.variance_techniques.cuped_method).toBe("pre_period");
    expect(comparison).toEqual(pooled);
    expect(pairOnly.control.point_estimate).not.toBe(comparison?.control.point_estimate);
    expect(pairOnly.treatment.point_estimate).not.toBe(comparison?.treatment.point_estimate);
  });
});

function multiArmCountInput(options: {
  readonly control: readonly number[];
  readonly treatment_a: readonly number[];
  readonly treatment_b: readonly number[];
  readonly winsorize_pct: number;
  readonly cuped: boolean;
  readonly covariates?: readonly CupedCovariateRow[];
}): StatsInput {
  const variants = ["control", "treatment_a", "treatment_b"] as const;
  const valuesByVariant = {
    control: options.control,
    treatment_a: options.treatment_a,
    treatment_b: options.treatment_b,
  };
  return {
    run_id: RUN_ID,
    analysis_version: "analysis-v2",
    confidence_level: 0.95,
    horizon: "sequential",
    allocation: { control: 34, treatment_a: 33, treatment_b: 33 },
    control_variant: "control",
    decision_family: [],
    guardrail_decisions: [
      {
        metric_id: "revenue",
        variant: "treatment_a",
        downside_threshold_pct: -10,
        guardrail_locked_at_run_start: true,
        threshold_locked_at_run_start: true,
      },
    ],
    metric_variance_config: [
      {
        metric_id: "revenue",
        winsorize: options.winsorize_pct < 100,
        winsorize_pct: options.winsorize_pct,
        cuped: options.cuped,
        cuped_coverage_threshold_pct: 70,
      },
    ],
    exposures: variants.flatMap((variant) =>
      valuesByVariant[variant].map((_value, index) => exposure(variant, `${variant}_${index}`)),
    ),
    metric_values: variants.flatMap((variant) =>
      valuesByVariant[variant].map((value, index) => countRow(variant, index, value)),
    ),
    pre_period_covariates: options.covariates ? [...options.covariates] : [],
  };
}

function exposure(variant: string, targeting_key_hash: string): DedupeExposureRow {
  return {
    app_id: "app_1",
    targeting_key_hash,
    environment_id: "env_1",
    id_type: "user",
    run_id: RUN_ID,
    variant,
    first_exposure_ts: ENGINE_TS,
    window_anchor: ENGINE_TS,
  };
}

function countRow(variant: string, index: number, value: number): PerEntityMetricRow {
  return {
    targeting_key_hash: `${variant}_${index}`,
    run_id: RUN_ID,
    metric_id: "revenue",
    metric_type: "count",
    value,
    in_window: true,
  };
}

function prePeriodRows(variant: string, values: readonly number[]): CupedCovariateRow[] {
  return values.map((value, index) => ({
    targeting_key_hash: `${variant}_${index}`,
    metric_id: "revenue",
    pre_period_value: value,
    covariate_source: "pre_period",
  }));
}
