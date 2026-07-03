import type { DedupeExposureRow, PerEntityMetricRow } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { computeSequentialCI } from "./sequential-ci.js";
import { estimateMetricArm, estimateMetricComparison } from "./variance-estimators.js";

const RUN_ID = "run_variance_golden";

describe("variance estimator golden fixtures", () => {
  it("uses Ratio covariance in the relative-lift CI input", () => {
    const result = estimateMetricComparison({
      run_id: RUN_ID,
      metric_id: "ratio_metric",
      metric_type: "ratio",
      control_variant: "control",
      treatment_variant: "treatment",
      exposures: [
        ...exposures("control", ["c1", "c2", "c3", "c4"]),
        ...exposures("treatment", ["t1", "t2", "t3", "t4"]),
      ],
      metric_values: [
        ratioRow("c1", 2, 1),
        ratioRow("c2", 2, 2),
        ratioRow("c3", 2, 3),
        ratioRow("c4", 2, 4),
        ratioRow("t1", 5, 1),
        ratioRow("t2", 4, 2),
        ratioRow("t3", 3, 3),
        ratioRow("t4", 2, 4),
      ],
    });

    expect(result.control.point_estimate).toBe(0.8);
    expect(result.control.sampling_var).toBeCloseTo(0.042666666666666665, 15);
    expect(result.treatment.point_estimate).toBe(1.4);
    expect(result.treatment.sampling_var).toBeCloseTo(0.384, 15);
    expect(result.relative_lift_pct).toBeCloseTo(75, 12);
    expect(result.sampling_var).toBeCloseTo(8041.666666666665, 12);

    const covarianceAware = computeSequentialCI({
      estimate: result.relative_lift_pct ?? Number.NaN,
      sampling_var: result.sampling_var ?? Number.NaN,
      n_t: result.treatment.sample_size_n,
      n_c: result.control.sample_size_n,
      alpha: 0.05,
      target_n: 8,
    });
    const covarianceFreeWrongAnswer = computeSequentialCI({
      estimate: result.relative_lift_pct ?? Number.NaN,
      sampling_var: 5125,
      n_t: result.treatment.sample_size_n,
      n_c: result.control.sample_size_n,
      alpha: 0.05,
      target_n: 8,
    });

    expect(covarianceAware.boundary).toBeCloseTo(272.17563538849726, 12);
    expect(covarianceAware.ci_lower).toBeCloseTo(-197.17563538849726, 12);
    expect(covarianceAware.ci_upper).toBeCloseTo(347.17563538849726, 12);
    expect(covarianceFreeWrongAnswer.boundary).toBeCloseTo(217.2816980744117, 12);
    expect(covarianceFreeWrongAnswer.boundary).toBeLessThan(covarianceAware.boundary);
  });

  it("proves event-row variance is the wrong answer for clustered Entities", () => {
    const metric_values = [
      ...Array.from({ length: 10 }, () => metricRow("cluster_high", 1)),
      ...Array.from({ length: 10 }, () => metricRow("cluster_low", 0)),
    ];
    const result = estimateMetricArm({
      run_id: RUN_ID,
      metric_id: "clustered_count",
      metric_type: "count",
      variant: "treatment",
      exposures: exposures("treatment", ["cluster_high", "cluster_low"]),
      metric_values,
    });
    const eventRowSamplingVar = wrongEventRowSamplingVar(metric_values.map((row) => row.value));

    expect(result.sample_size_n).toBe(2);
    expect(result.point_estimate).toBe(5);
    expect(result.sampling_var).toBe(25);
    expect(eventRowSamplingVar).toBeCloseTo(0.013157894736842105, 15);
    expect((result.sampling_var ?? 0) / eventRowSamplingVar).toBeCloseTo(1900, 12);
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

function ratioRow(targeting_key_hash: string, num_value: number, denom_value: number) {
  return {
    targeting_key_hash,
    run_id: RUN_ID,
    metric_id: "ratio_metric",
    metric_type: "ratio",
    value: 0,
    num_value,
    denom_value,
    in_window: true,
  } satisfies PerEntityMetricRow;
}

function metricRow(targeting_key_hash: string, value: number): PerEntityMetricRow {
  return {
    targeting_key_hash,
    run_id: RUN_ID,
    metric_id: "clustered_count",
    metric_type: "count",
    value,
    in_window: true,
  };
}

function wrongEventRowSamplingVar(values: readonly number[]): number {
  const center = values.reduce((sum, value) => sum + value, 0) / values.length;
  const sampleVariance =
    values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1);
  return sampleVariance / values.length;
}
