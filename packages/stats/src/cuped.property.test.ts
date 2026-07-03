import type { DedupeExposureRow, PerEntityMetricRow } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import type { CupedCovariateRow } from "./variance-estimator-types.js";
import { estimateMetricComparison } from "./variance-estimators.js";

const RUN_ID = "run_cuped_property";

describe("CUPED metamorphic properties", () => {
  it("leaves point estimates and variance unchanged when the CUPED covariate is uncorrelated", () => {
    const raw = cupedComparison({
      controlValues: [1, 2, 3, 4],
      treatmentValues: [2, 3, 4, 5],
      covariates: [3, -1, 5, 1],
    });
    const adjusted = cupedComparison({
      controlValues: [1, 2, 3, 4],
      treatmentValues: [2, 3, 4, 5],
      covariates: [3, -1, 5, 1],
      cuped: true,
    });

    expect(adjusted.control.point_estimate).toBe(raw.control.point_estimate);
    expect(adjusted.treatment.point_estimate).toBe(raw.treatment.point_estimate);
    expect(adjusted.control.sampling_var).toBeCloseTo(raw.control.sampling_var ?? 0, 15);
    expect(adjusted.treatment.sampling_var).toBeCloseTo(raw.treatment.sampling_var ?? 0, 15);
    expect(adjusted.variance_techniques.cuped_method).toBe("pre_period");
  });

  it("scales CUPED-adjusted additive estimates and variance with positive scaling of Y", () => {
    const base = cupedComparison({
      controlValues: [1, 4, 6, 10],
      treatmentValues: [2, 5, 7, 11],
      covariates: [1, 2, 3, 4],
      cuped: true,
    });
    const scaled = cupedComparison({
      controlValues: [3, 12, 18, 30],
      treatmentValues: [6, 15, 21, 33],
      covariates: [1, 2, 3, 4],
      cuped: true,
    });

    expect(scaled.control.point_estimate).toBeCloseTo((base.control.point_estimate ?? 0) * 3, 12);
    expect(scaled.treatment.point_estimate).toBeCloseTo(
      (base.treatment.point_estimate ?? 0) * 3,
      12,
    );
    expect(scaled.absolute_lift).toBeCloseTo((base.absolute_lift ?? 0) * 3, 12);
    expect(scaled.control.sampling_var).toBeCloseTo((base.control.sampling_var ?? 0) * 9, 12);
    expect(scaled.treatment.sampling_var).toBeCloseTo((base.treatment.sampling_var ?? 0) * 9, 12);
  });

  it("forces the same attribute covariate technique across arms", () => {
    const result = estimateMetricComparison({
      run_id: RUN_ID,
      metric_id: "count_metric",
      metric_type: "count",
      control_variant: "control",
      treatment_variant: "treatment",
      exposures: [
        ...exposures("control", ["c1", "c2", "c3", "c4"]),
        ...exposures("treatment", ["t1", "t2", "t3", "t4"]),
      ],
      metric_values: [
        countRow("c1", 0),
        countRow("c2", 10),
        countRow("c3", 20),
        countRow("c4", 30),
        countRow("t1", 1),
        countRow("t2", 2),
        countRow("t3", 3),
        countRow("t4", 100),
      ],
      pre_period_covariates: [
        ...attributeRows("control_best", ["c1", "c2", "c3", "c4"], [0, 1, 2, 3]),
        ...attributeRows("control_best", ["t1", "t2", "t3", "t4"], [3, 2, 1, 0]),
        ...attributeRows("treatment_best", ["c1", "c2", "c3", "c4"], [3, 1, 2, 0]),
        ...attributeRows("treatment_best", ["t1", "t2", "t3", "t4"], [1, 2, 3, 100]),
      ],
      winsorize: false,
    });

    expect(result.variance_techniques.cuped_method).toBe("attribute_covariate");
    expect(result.control.variance_techniques.cuped_attribute).toBe(
      result.variance_techniques.cuped_attribute,
    );
    expect(result.treatment.variance_techniques.cuped_attribute).toBe(
      result.variance_techniques.cuped_attribute,
    );
  });
});

function cupedComparison({
  controlValues,
  treatmentValues,
  covariates,
  cuped = false,
}: {
  controlValues: readonly number[];
  treatmentValues: readonly number[];
  covariates: readonly number[];
  cuped?: boolean;
}) {
  const controlIds = controlValues.map((_, index) => `c${index}`);
  const treatmentIds = treatmentValues.map((_, index) => `t${index}`);
  return estimateMetricComparison({
    run_id: RUN_ID,
    metric_id: "count_metric",
    metric_type: "count",
    control_variant: "control",
    treatment_variant: "treatment",
    exposures: [...exposures("control", controlIds), ...exposures("treatment", treatmentIds)],
    metric_values: [
      ...controlIds.map((entityId, index) => countRow(entityId, controlValues[index] ?? 0)),
      ...treatmentIds.map((entityId, index) => countRow(entityId, treatmentValues[index] ?? 0)),
    ],
    pre_period_covariates: cuped
      ? [
          ...controlIds.map((entityId, index) => prePeriodRow(entityId, covariates[index] ?? 0)),
          ...treatmentIds.map((entityId, index) => prePeriodRow(entityId, covariates[index] ?? 0)),
        ]
      : [],
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

function prePeriodRow(targeting_key_hash: string, pre_period_value: number): CupedCovariateRow {
  return {
    targeting_key_hash,
    metric_id: "count_metric",
    pre_period_value,
    covariate_source: "pre_period",
  };
}

function attributeRows(
  attribute: string,
  entityIds: readonly string[],
  values: readonly number[],
): CupedCovariateRow[] {
  return entityIds.map((targeting_key_hash, index) => ({
    targeting_key_hash,
    metric_id: attribute,
    attribute,
    pre_period_value: values[index] ?? 0,
    covariate_source: "historical_attribute",
    locked: true,
  }));
}
