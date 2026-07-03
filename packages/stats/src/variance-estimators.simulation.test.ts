import type { DedupeExposureRow, PerEntityMetricRow } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { estimateMetricArm } from "./variance-estimators.js";

const RUN_ID = "run_variance_simulation";

describe("variance estimator negative-path simulations", () => {
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
