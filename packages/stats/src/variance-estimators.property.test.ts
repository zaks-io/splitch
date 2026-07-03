import type { DedupeExposureRow, PerEntityMetricRow } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { computeSequentialCI } from "./sequential-ci.js";
import { estimateMetricArm, estimateMetricComparison } from "./variance-estimators.js";

const RUN_ID = "run_variance_property";
const ALPHA = 0.05;

describe("variance estimator metamorphic properties", () => {
  it("scales additive point estimates and CI bounds without changing p-values", () => {
    const base = countComparison(1);
    const scale = 7.3;
    const scaled = countComparison(scale);
    const baseCi = absoluteLiftCI(base);
    const scaledCi = absoluteLiftCI(scaled);

    expect(scaled.control.point_estimate).toBeCloseTo(
      (base.control.point_estimate ?? 0) * scale,
      12,
    );
    expect(scaled.treatment.point_estimate).toBeCloseTo(
      (base.treatment.point_estimate ?? 0) * scale,
      12,
    );
    expect(scaled.absolute_lift).toBeCloseTo((base.absolute_lift ?? 0) * scale, 12);
    expect(scaled.absolute_lift_sampling_var).toBeCloseTo(
      (base.absolute_lift_sampling_var ?? 0) * scale ** 2,
      12,
    );
    expect(scaledCi.ci_lower).toBeCloseTo(baseCi.ci_lower * scale, 12);
    expect(scaledCi.ci_upper).toBeCloseTo(baseCi.ci_upper * scale, 12);
    expect(scaledCi.p_value).toBeCloseTo(baseCi.p_value, 15);
  });

  it("keeps per-Entity Count values unchanged when rows are split", () => {
    const exposuresForArm = exposures("treatment", ["u1", "u2", "u3"]);
    const unsplit = estimateMetricArm({
      run_id: RUN_ID,
      metric_id: "count_metric",
      metric_type: "count",
      variant: "treatment",
      exposures: exposuresForArm,
      metric_values: [countRow("u1", 6), countRow("u2", 2), countRow("u3", 0)],
    });
    const split = estimateMetricArm({
      run_id: RUN_ID,
      metric_id: "count_metric",
      metric_type: "count",
      variant: "treatment",
      exposures: exposuresForArm,
      metric_values: [
        countRow("u1", 1),
        countRow("u1", 2),
        countRow("u1", 3),
        countRow("u2", 0.5),
        countRow("u2", 1.5),
        countRow("u3", 0),
      ],
    });

    expect(split.point_estimate).toBe(unsplit.point_estimate);
    expect(split.sampling_var).toBe(unsplit.sampling_var);
    expect(split.sample_size_n).toBe(unsplit.sample_size_n);
  });
});

function countComparison(scale: number) {
  return estimateMetricComparison({
    run_id: RUN_ID,
    metric_id: "count_metric",
    metric_type: "count",
    control_variant: "control",
    treatment_variant: "treatment",
    exposures: [
      ...exposures("control", ["c1", "c2", "c3"]),
      ...exposures("treatment", ["t1", "t2", "t3"]),
    ],
    metric_values: [
      countRow("c1", 2 * scale),
      countRow("c2", 4 * scale),
      countRow("c3", 6 * scale),
      countRow("t1", 4 * scale),
      countRow("t2", 8 * scale),
      countRow("t3", 10 * scale),
    ],
  });
}

function absoluteLiftCI(result: ReturnType<typeof countComparison>) {
  return computeSequentialCI({
    estimate: result.absolute_lift ?? Number.NaN,
    sampling_var: result.absolute_lift_sampling_var ?? Number.NaN,
    n_t: result.treatment.sample_size_n,
    n_c: result.control.sample_size_n,
    alpha: ALPHA,
    target_n: 6,
  });
}

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
    metric_id: "count_metric",
    metric_type: "count",
    value,
    in_window: true,
  };
}
