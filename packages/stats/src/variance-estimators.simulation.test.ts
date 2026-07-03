import type { DedupeExposureRow, PerEntityMetricRow } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import type { CupedCovariateRow } from "./variance-estimator-types.js";
import { estimateMetricArm, estimateMetricComparison } from "./variance-estimators.js";

const RUN_ID = "run_variance_simulation";

describe("variance estimator negative-path simulations", () => {
  it("reduces heavy-tail additive variance while keeping sample size unchanged", () => {
    const controlIds = Array.from({ length: 10 }, (_, index) => `control_${index}`);
    const treatmentIds = Array.from({ length: 10 }, (_, index) => `treatment_${index}`);
    const metric_values = [
      ...controlIds.map((entityId) => countRow(entityId, 1)),
      ...treatmentIds.map((entityId, index) => countRow(entityId, index === 9 ? 1_000 : 1)),
    ];
    const raw = estimateMetricComparison({
      run_id: RUN_ID,
      metric_id: "clustered_count",
      metric_type: "count",
      control_variant: "control",
      treatment_variant: "treatment",
      exposures: [...exposures("control", controlIds), ...exposures("treatment", treatmentIds)],
      metric_values,
      winsorize: false,
    });
    const winsorized = estimateMetricComparison({
      run_id: RUN_ID,
      metric_id: "clustered_count",
      metric_type: "count",
      control_variant: "control",
      treatment_variant: "treatment",
      exposures: [...exposures("control", controlIds), ...exposures("treatment", treatmentIds)],
      metric_values,
      winsorize_pct: 90,
    });

    expect(winsorized.treatment.sample_size_n).toBe(raw.treatment.sample_size_n);
    expect(winsorized.treatment.sampling_var).toBeLessThan(raw.treatment.sampling_var ?? 0);
    expect(winsorized.variance_techniques).toMatchObject({
      winsorized: true,
      winsorize_pct: 90,
      winsorize_cap: 1,
    });
  });

  it("rejects an event-row variance fake under clustered data", () => {
    const entityIds = Array.from({ length: 12 }, (_, index) => `entity_${index}`);
    const metric_values = entityIds.flatMap((entityId, index) =>
      Array.from({ length: 8 }, () => countRow(entityId, index % 2 === 0 ? 1 : 0)),
    );
    const result = estimateMetricArm({
      run_id: RUN_ID,
      metric_id: "clustered_count",
      metric_type: "count",
      variant: "treatment",
      exposures: exposures("treatment", entityIds),
      metric_values,
    });

    const wrong = wrongSamplingVar(metric_values.map((row) => row.value));

    expect(result.sampling_var).toBeGreaterThan(wrong * 100);
  });

  it("rejects a covariance-free Ratio variance fake under correlated numerator and denominator", () => {
    const entityIds = Array.from({ length: 20 }, (_, index) => `ratio_${index}`);
    const metric_values = entityIds.map((entityId, index) => {
      const denom = index + 1;
      return ratioRow(entityId, 22 - denom, denom);
    });
    const result = estimateMetricArm({
      run_id: RUN_ID,
      metric_id: "ratio_metric",
      metric_type: "ratio",
      variant: "treatment",
      exposures: exposures("treatment", entityIds),
      metric_values,
    });
    const wrong = covarianceFreeRatioSamplingVar(
      metric_values.map((row) => row.num_value ?? 0),
      metric_values.map((row) => row.denom_value ?? 0),
    );

    expect(result.status).toBe("ready");
    expect(result.sampling_var).toBeGreaterThan(wrong * 1.9);
  });

  it("reduces variance with pre-period CUPED without shifting the null mean", () => {
    const entityCount = 120;
    const controlIds = Array.from({ length: entityCount }, (_, index) => `control_${index}`);
    const treatmentIds = Array.from({ length: entityCount }, (_, index) => `treatment_${index}`);
    const values = Array.from({ length: entityCount }, (_, index) => {
      const covariate = centeredWave(index);
      const noise = centeredWave(index * 17 + 5) / 5;
      return { covariate, value: 10 + covariate * 2 + noise };
    });
    const metric_values = [
      ...controlIds.map((entityId, index) => countRow(entityId, values[index]?.value ?? 0)),
      ...treatmentIds.map((entityId, index) => countRow(entityId, values[index]?.value ?? 0)),
    ];
    const pre_period_covariates = [
      ...controlIds.map((entityId, index) => prePeriodRow(entityId, values[index]?.covariate ?? 0)),
      ...treatmentIds.map((entityId, index) =>
        prePeriodRow(entityId, values[index]?.covariate ?? 0),
      ),
    ];
    const raw = estimateMetricComparison({
      run_id: RUN_ID,
      metric_id: "clustered_count",
      metric_type: "count",
      control_variant: "control",
      treatment_variant: "treatment",
      exposures: [...exposures("control", controlIds), ...exposures("treatment", treatmentIds)],
      metric_values,
      winsorize: false,
      cuped: false,
    });
    const cuped = estimateMetricComparison({
      run_id: RUN_ID,
      metric_id: "clustered_count",
      metric_type: "count",
      control_variant: "control",
      treatment_variant: "treatment",
      exposures: [...exposures("control", controlIds), ...exposures("treatment", treatmentIds)],
      metric_values,
      pre_period_covariates,
      winsorize: false,
    });

    expect(cuped.absolute_lift).toBeCloseTo(raw.absolute_lift ?? Number.NaN, 12);
    expect(cuped.absolute_lift).toBeCloseTo(0, 12);
    expect(cuped.absolute_lift_sampling_var).toBeLessThan(
      (raw.absolute_lift_sampling_var ?? 0) / 10,
    );
    expect(cuped.variance_techniques.cuped_method).toBe("pre_period");
  });
});

function exposures(variant: string, entityIds: readonly string[]): DedupeExposureRow[] {
  return entityIds.map((targeting_key_hash) => ({
    app_id: "app_1",
    targeting_key_hash,
    environment_id: "env_1",
    id_type: "user",
    run_id: RUN_ID,
    variant,
    first_exposure_ts: "2026-07-01T00:00:00.000Z",
    window_anchor: "2026-07-01T00:00:00.000Z",
  }));
}

function countRow(targeting_key_hash: string, value: number): PerEntityMetricRow {
  return {
    targeting_key_hash,
    run_id: RUN_ID,
    metric_id: "clustered_count",
    metric_type: "count",
    value,
    in_window: true,
  };
}

function ratioRow(
  targeting_key_hash: string,
  num_value: number,
  denom_value: number,
): PerEntityMetricRow {
  return {
    targeting_key_hash,
    run_id: RUN_ID,
    metric_id: "ratio_metric",
    metric_type: "ratio",
    value: 0,
    num_value,
    denom_value,
    in_window: true,
  };
}

function covarianceFreeRatioSamplingVar(
  nums: readonly number[],
  denoms: readonly number[],
): number {
  const numeratorMean = mean(nums);
  const denominatorMean = mean(denoms);
  const armVariance =
    sampleVariance(nums) / denominatorMean ** 2 +
    (numeratorMean ** 2 * sampleVariance(denoms)) / denominatorMean ** 4;
  return armVariance / nums.length;
}

function wrongSamplingVar(values: readonly number[]): number {
  return sampleVariance(values) / values.length;
}

function sampleVariance(values: readonly number[]): number {
  const center = mean(values);
  return values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1);
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function prePeriodRow(targeting_key_hash: string, pre_period_value: number): CupedCovariateRow {
  return {
    targeting_key_hash,
    metric_id: "clustered_count",
    pre_period_value,
    covariate_source: "pre_period",
  };
}

function centeredWave(index: number): number {
  return Math.sin(index * 1.819) + Math.cos(index * 0.731);
}
