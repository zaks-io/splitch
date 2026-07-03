import { describe, expect, it } from "vitest";
import {
  ActivationRowSchema,
  DecisionFamilyMemberSchema,
  DedupeExposureRowSchema,
  PerEntityMetricRowSchema,
  PrePeriodRowSchema,
  StatsInputSchema,
} from "./stats-input-contract.js";

const exposureRow = {
  app_id: "app_1",
  targeting_key_hash: "tkh_1",
  environment_id: "env_1",
  id_type: "user",
  run_id: "run_1",
  variant: "treatment",
  first_exposure_ts: "2026-07-01T00:00:00.000Z",
  window_anchor: "2026-07-01T00:00:00.000Z",
};

const metricRow = {
  targeting_key_hash: "tkh_1",
  run_id: "run_1",
  metric_id: "metric_1",
  metric_type: "binomial",
  value: 1,
  in_window: true,
};

const decisionFamilyMember = {
  metric_id: "metric_1",
  variant: "treatment",
};

describe("DedupeExposureRowSchema", () => {
  it("requires the stats input dedupe fields", () => {
    expect(DedupeExposureRowSchema.parse(exposureRow).id_type).toBe("user");

    const { id_type: _, ...missingIdType } = exposureRow;
    expect(DedupeExposureRowSchema.safeParse(missingIdType).success).toBe(false);
  });
});

describe("PerEntityMetricRowSchema", () => {
  it("requires value and in_window for every Metric row", () => {
    expect(PerEntityMetricRowSchema.parse(metricRow).value).toBe(1);

    const { value: _, ...missingValue } = metricRow;
    expect(PerEntityMetricRowSchema.safeParse(missingValue).success).toBe(false);
  });

  it("uses the MetricKind leaf for metric_type", () => {
    expect(PerEntityMetricRowSchema.safeParse({ ...metricRow, metric_type: "ratio" }).success).toBe(
      false,
    );
    expect(
      PerEntityMetricRowSchema.safeParse({ ...metricRow, metric_type: "median" }).success,
    ).toBe(false);
  });

  it("requires Ratio numerator and denominator values but allows a zero denominator", () => {
    expect(
      PerEntityMetricRowSchema.parse({
        ...metricRow,
        metric_type: "ratio",
        value: 0,
        num_value: 3,
        denom_value: 0,
      }).denom_value,
    ).toBe(0);

    expect(
      PerEntityMetricRowSchema.safeParse({
        ...metricRow,
        metric_type: "ratio",
        num_value: 3,
      }).success,
    ).toBe(false);

    expect(
      PerEntityMetricRowSchema.safeParse({
        ...metricRow,
        metric_type: "ratio",
        denom_value: 4,
      }).success,
    ).toBe(false);
  });
});

describe("PrePeriodRowSchema", () => {
  it("parses the CUPED covariate source enum", () => {
    for (const covariate_source of ["pre_period", "declared_attribute", "historical_attribute"]) {
      expect(
        PrePeriodRowSchema.safeParse({
          targeting_key_hash: "tkh_1",
          metric_id: "metric_1",
          pre_period_value: 12,
          covariate_source,
        }).success,
      ).toBe(true);
    }

    expect(
      PrePeriodRowSchema.safeParse({
        targeting_key_hash: "tkh_1",
        metric_id: "metric_1",
        pre_period_value: 12,
        covariate_source: "lookback",
      }).success,
    ).toBe(false);
  });
});

describe("ActivationRowSchema", () => {
  it("parses the Activation gate row fields", () => {
    const row = ActivationRowSchema.parse({
      targeting_key_hash: "tkh_1",
      run_id: "run_1",
      activation_ts: "2026-07-01T00:05:00.000Z",
      counterfactual: false,
      activated: true,
    });

    expect(row.activated).toBe(true);
  });
});

describe("DecisionFamilyMemberSchema", () => {
  it("keeps Dimension fields optional and nullable", () => {
    expect(DecisionFamilyMemberSchema.parse(decisionFamilyMember).dimension_id).toBeUndefined();
    expect(
      DecisionFamilyMemberSchema.parse({
        ...decisionFamilyMember,
        dimension_id: null,
        dimension_value: null,
      }).dimension_value,
    ).toBeNull();
  });
});

describe("StatsInputSchema", () => {
  it("parses the final stats engine input shape with defaults", () => {
    const input = StatsInputSchema.parse({
      run_id: "run_1",
      decision_family: [decisionFamilyMember],
      exposures: [exposureRow],
      metric_values: [metricRow],
    });

    expect(input.confidence_level).toBe(0.95);
    expect(input.horizon).toBe("sequential");
  });

  it("requires sample_size_locked for fixed horizon input", () => {
    expect(
      StatsInputSchema.safeParse({
        run_id: "run_1",
        horizon: "fixed",
        decision_family: [decisionFamilyMember],
        exposures: [exposureRow],
        metric_values: [metricRow],
      }).success,
    ).toBe(false);

    expect(
      StatsInputSchema.safeParse({
        run_id: "run_1",
        horizon: "fixed",
        sample_size_locked: 1000,
        decision_family: [decisionFamilyMember],
        exposures: [exposureRow],
        metric_values: [metricRow],
      }).success,
    ).toBe(true);
  });
});
