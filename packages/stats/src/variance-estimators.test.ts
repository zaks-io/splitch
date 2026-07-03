import type { DedupeExposureRow, MetricKind, PerEntityMetricRow } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { estimateMetricArm, estimateMetricComparison } from "./variance-estimators.js";

const RUN_ID = "run_variance";

describe("variance estimators", () => {
  it("uses Bernoulli p(1-p)/n for Binomial Metrics over exposed Entities", () => {
    const result = estimateMetricArm({
      run_id: RUN_ID,
      metric_id: "conversion",
      metric_type: "binomial",
      variant: "treatment",
      exposures: exposures("treatment", ["u1", "u2", "u3", "u4"]),
      metric_values: [
        metricRow("conversion", "binomial", "u1", 1),
        metricRow("conversion", "binomial", "u3", 1),
      ],
    });

    expect(result).toMatchObject({
      sample_size_n: 4,
      point_estimate: 0.5,
      sampling_var: 0.0625,
      status: "ready",
      delta_method: false,
    });
  });

  it("never winsorizes Binomial Metrics, even when winsorization is requested", () => {
    const result = estimateMetricComparison({
      run_id: RUN_ID,
      metric_id: "conversion",
      metric_type: "binomial",
      control_variant: "control",
      treatment_variant: "treatment",
      exposures: [...exposures("control", ["c1", "c2"]), ...exposures("treatment", ["t1", "t2"])],
      metric_values: [
        metricRow("conversion", "binomial", "c1", 500),
        metricRow("conversion", "binomial", "t1", 1),
      ],
      winsorize: true,
      winsorize_pct: 50,
    });

    expect(result.control.point_estimate).toBe(0.5);
    expect(result.treatment.point_estimate).toBe(0.5);
    expect(result.variance_techniques).toMatchObject({
      winsorized: false,
      winsorize_pct: null,
      winsorize_cap: null,
      delta_method: false,
    });
  });

  it("uses sample variance of per-Entity sums for Count and Revenue Metrics", () => {
    for (const metric_type of ["count", "revenue"] as const) {
      const result = estimateMetricArm({
        run_id: RUN_ID,
        metric_id: metric_type,
        metric_type,
        variant: "control",
        exposures: exposures("control", ["u1", "u2", "u3"]),
        metric_values: [
          metricRow(metric_type, metric_type, "u1", 2),
          metricRow(metric_type, metric_type, "u2", 4),
          metricRow(metric_type, metric_type, "u3", 6),
        ],
      });

      expect(result.point_estimate).toBe(4);
      expect(result.arm_variance).toBe(4);
      expect(result.sampling_var).toBeCloseTo(4 / 3, 15);
    }
  });

  it("leaves winsorization metadata null when the additive none path is requested", () => {
    const result = estimateMetricComparison({
      run_id: RUN_ID,
      metric_id: "orders",
      metric_type: "count",
      control_variant: "control",
      treatment_variant: "treatment",
      exposures: [...exposures("control", ["c1", "c2"]), ...exposures("treatment", ["t1", "t2"])],
      metric_values: [
        metricRow("orders", "count", "c1", 1),
        metricRow("orders", "count", "c2", 2),
        metricRow("orders", "count", "t1", 3),
        metricRow("orders", "count", "t2", 100),
      ],
      winsorize: false,
      winsorize_pct: 50,
    });

    expect(result.treatment.point_estimate).toBe(51.5);
    expect(result.variance_techniques).toMatchObject({
      winsorized: false,
      winsorize_pct: null,
      winsorize_cap: null,
    });
  });

  it("fails loud when a Ratio arm denominator mean is zero", () => {
    const result = estimateMetricArm({
      run_id: RUN_ID,
      metric_id: "click_rate",
      metric_type: "ratio",
      variant: "treatment",
      exposures: exposures("treatment", ["u1", "u2"]),
      metric_values: [ratioRow("click_rate", "u1", 2, 0), ratioRow("click_rate", "u2", 3, 0)],
    });

    expect(result).toMatchObject({
      status: "insufficient_denominator",
      point_estimate: null,
      sampling_var: null,
      denominator_mean: 0,
      zero_denominator_entity_count: 2,
      delta_method: true,
    });
  });

  it("keeps absolute lift when Control estimate is zero and nulls relative lift", () => {
    const result = estimateMetricComparison({
      run_id: RUN_ID,
      metric_id: "orders",
      metric_type: "count",
      control_variant: "control",
      treatment_variant: "treatment",
      exposures: [...exposures("control", ["c1", "c2"]), ...exposures("treatment", ["t1", "t2"])],
      metric_values: [metricRow("orders", "count", "t1", 3), metricRow("orders", "count", "t2", 5)],
    });

    expect(result.absolute_lift).toBe(4);
    expect(result.absolute_lift_sampling_var).toBe(1);
    expect(result.relative_lift_pct).toBeNull();
    expect(result.sampling_var).toBeNull();
    expect(result.status).toBe("insufficient_denominator");
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

function metricRow(
  metric_id: string,
  metric_type: Exclude<MetricKind, "ratio">,
  targeting_key_hash: string,
  value: number,
): PerEntityMetricRow {
  return {
    targeting_key_hash,
    run_id: RUN_ID,
    metric_id,
    metric_type,
    value,
    in_window: true,
  };
}

function ratioRow(
  metric_id: string,
  targeting_key_hash: string,
  num_value: number,
  denom_value: number,
): PerEntityMetricRow {
  return {
    targeting_key_hash,
    run_id: RUN_ID,
    metric_id,
    metric_type: "ratio",
    value: 0,
    num_value,
    denom_value,
    in_window: true,
  };
}
