import type { DedupeExposureRow, PerEntityMetricRow } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import type { CupedCovariateRow } from "./variance-estimator-types";
import { estimateMetricComparison } from "./variance-estimators";

const RUN_ID = "run_cuped_golden";

describe("CUPED golden fixtures", () => {
  it("applies pre-period CUPED and reports the explicit method metadata", () => {
    const result = countComparison({
      controlValues: [10, 12, 14, 16],
      treatmentValues: [11, 13, 15, 17],
      pre_period_covariates: [
        ...covariates("control", [5, 6, 7, 8]),
        ...covariates("treatment", [5, 6, 7, 8]),
      ],
    });

    expect(result.control.point_estimate).toBe(13);
    expect(result.treatment.point_estimate).toBe(14);
    expect(result.control.sampling_var).toBeCloseTo(0, 15);
    expect(result.treatment.sampling_var).toBeCloseTo(0, 15);
    expect(result.variance_techniques).toMatchObject({
      cuped_applied: true,
      cuped_method: "pre_period",
      cuped_attribute: null,
      cuped_attribute_source: null,
      cuped_coverage_pct: 100,
    });
  });

  it("reports the none CUPED path when pre-period coverage is below threshold", () => {
    const result = countComparison({
      controlValues: [10, 12, 14, 16],
      treatmentValues: [11, 13, 15, 17],
      pre_period_covariates: [
        prePeriodRow("c1", 5),
        prePeriodRow("c2", 6),
        prePeriodRow("t1", 5),
        prePeriodRow("t2", 6),
      ],
    });

    expect(result.control.sampling_var).toBeCloseTo(1.6666666666666667, 15);
    expect(result.treatment.sampling_var).toBeCloseTo(1.6666666666666667, 15);
    expect(result.variance_techniques).toMatchObject({
      cuped_applied: false,
      cuped_method: "none",
      cuped_attribute: null,
      cuped_attribute_source: null,
      cuped_coverage_pct: 50,
    });
  });
});

describe("CUPED attribute and anchor golden fixtures", () => {
  it("selects only locked eligible attribute covariates for fallback", () => {
    const result = countComparison({
      controlValues: [10, 12, 14, 16],
      treatmentValues: [11, 13, 15, 17],
      pre_period_covariates: [
        ...attributeRows("plan_after", ["c1", "c2", "c3", "c4"], [50, 60, 70, 80], false),
        ...attributeRows("plan_after", ["t1", "t2", "t3", "t4"], [50, 60, 70, 80], false),
        ...attributeRows("signup_cohort", ["c1", "c2", "c3", "c4"], [5, 6, 7, 8], true),
        ...attributeRows("signup_cohort", ["t1", "t2", "t3", "t4"], [5, 6, 7, 8], true),
      ],
    });

    expect(result.control.sampling_var).toBeCloseTo(0, 15);
    expect(result.variance_techniques).toMatchObject({
      cuped_applied: true,
      cuped_method: "attribute_covariate",
      cuped_attribute: "signup_cohort",
      cuped_attribute_source: "historical_selected",
      cuped_coverage_pct: 100,
    });
  });

  it("rejects post-treatment attribute covariates before scoring fallback candidates", () => {
    expect(() =>
      countComparison({
        controlValues: [1, 2],
        treatmentValues: [1, 2],
        pre_period_covariates: [
          attributeRow("spent_after_exposure", "c1", 9, "post_treatment", true),
        ],
      }),
    ).toThrow(/post-treatment CUPED covariates/);
  });

  it("rejects post-treatment attributes even when pre-period coverage is sufficient", () => {
    expect(() =>
      countComparison({
        controlValues: [10, 12],
        treatmentValues: [11, 13],
        pre_period_covariates: [
          prePeriodRow("c1", 5),
          prePeriodRow("c2", 6),
          prePeriodRow("t1", 5),
          prePeriodRow("t2", 6),
          attributeRow("spent_after_exposure", "c1", 9, "post_treatment", true),
        ],
      }),
    ).toThrow(/post-treatment CUPED covariates/);
  });

  it("anchors pre-period validation at first_exposure_ts even with an Activation window anchor", () => {
    expect(() =>
      countComparison({
        controlValues: [1, 2],
        treatmentValues: [1, 2],
        activated: true,
        pre_period_covariates: [
          prePeriodRow("c1", 1, "2026-07-01T12:00:00.000Z"),
          prePeriodRow("c2", 2, "2026-06-30T12:00:00.000Z"),
          prePeriodRow("t1", 1, "2026-06-30T12:00:00.000Z"),
          prePeriodRow("t2", 2, "2026-06-30T12:00:00.000Z"),
        ],
      }),
    ).toThrow(/must be before first_exposure_ts/);
  });
});

function countComparison({
  controlValues,
  treatmentValues,
  pre_period_covariates,
  activated = false,
}: {
  controlValues: readonly number[];
  treatmentValues: readonly number[];
  pre_period_covariates: readonly CupedCovariateRow[];
  activated?: boolean;
}) {
  const controlIds = controlValues.map((_, index) => `c${index + 1}`);
  const treatmentIds = treatmentValues.map((_, index) => `t${index + 1}`);
  return estimateMetricComparison({
    run_id: RUN_ID,
    metric_id: "clustered_count",
    metric_type: "count",
    control_variant: "control",
    treatment_variant: "treatment",
    exposures: [
      ...exposures("control", controlIds, activated),
      ...exposures("treatment", treatmentIds, activated),
    ],
    metric_values: [
      ...controlIds.map((entityId, index) => metricRow(entityId, controlValues[index] ?? 0)),
      ...treatmentIds.map((entityId, index) => metricRow(entityId, treatmentValues[index] ?? 0)),
    ],
    pre_period_covariates,
  });
}

function exposures(
  variant: string,
  entityIds: readonly string[],
  activated: boolean,
): DedupeExposureRow[] {
  return entityIds.map((targeting_key_hash) => ({
    app_id: "app_1",
    targeting_key_hash,
    environment_id: "env_1",
    id_type: "user",
    run_id: RUN_ID,
    variant,
    first_exposure_ts: "2026-07-01T00:00:00.000Z",
    window_anchor: activated ? "2026-07-02T00:00:00.000Z" : "2026-07-01T00:00:00.000Z",
  }));
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

function covariates(arm: "control" | "treatment", values: readonly number[]): CupedCovariateRow[] {
  const prefix = arm === "control" ? "c" : "t";
  return values.map((value, index) => prePeriodRow(`${prefix}${index + 1}`, value));
}

function prePeriodRow(
  targeting_key_hash: string,
  pre_period_value: number,
  observed_at?: string,
): CupedCovariateRow {
  return {
    targeting_key_hash,
    metric_id: "clustered_count",
    pre_period_value,
    covariate_source: "pre_period",
    observed_at,
  };
}

function attributeRows(
  attribute: string,
  entityIds: readonly string[],
  values: readonly number[],
  locked: boolean,
): CupedCovariateRow[] {
  return entityIds.map((targeting_key_hash, index) =>
    attributeRow(attribute, targeting_key_hash, values[index] ?? 0, "historical_attribute", locked),
  );
}

function attributeRow(
  attribute: string,
  targeting_key_hash: string,
  pre_period_value: number,
  covariate_source: string,
  locked: boolean,
): CupedCovariateRow {
  return {
    targeting_key_hash,
    metric_id: attribute,
    attribute,
    pre_period_value,
    covariate_source,
    locked,
  } as CupedCovariateRow;
}
