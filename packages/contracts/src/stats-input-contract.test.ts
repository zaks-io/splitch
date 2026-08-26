import { describe, expect, it } from "vitest";
import {
  ActivationRowSchema,
  DedupeExposureRowSchema,
  MetricQueryConfigSchema,
  PerEntityMetricRowSchema,
  PrePeriodRowSchema,
  StatsInputSchema,
} from "./stats-input-contract";

describe("MetricQueryConfigSchema", () => {
  const window = { window_duration_ms: 1_000, cuped_lookback_ms: 2_000 };

  it("freezes Count and Revenue numeric fields", () => {
    expect(
      MetricQueryConfigSchema.parse({
        ...window,
        metric_id: "metric_cost",
        metric_type: "revenue",
        event_definition_id: "event_llm_call",
        event_field_name: "cost",
      }),
    ).toMatchObject({ event_field_name: "cost" });
    expect(
      MetricQueryConfigSchema.safeParse({
        ...window,
        metric_id: "metric_cost",
        metric_type: "revenue",
        event_definition_id: "event_llm_call",
      }).success,
    ).toBe(false);
  });

  it("freezes distinct non-Ratio source bindings as one Ratio config", () => {
    expect(
      MetricQueryConfigSchema.safeParse({
        ...window,
        metric_id: "metric_cost_per_token",
        metric_type: "ratio",
        numerator: {
          metric_id: "metric_cost",
          metric_type: "revenue",
          event_definition_id: "event_llm_call",
          event_field_name: "cost",
        },
        denominator: {
          metric_id: "metric_tokens",
          metric_type: "count",
          event_definition_id: "event_llm_call",
          event_field_name: "tokens",
        },
      }).success,
    ).toBe(true);
  });
});

const exposureRow = {
  app_id: "app_1",
  targeting_key_hash: "tkh_1",
  environment_id: "env_1",
  id_type: "user",
  run_id: "run_1",
  variant: "treatment",
  first_exposure_ts: "2026-07-01T00:00:00.000Z",
  window_anchor: "2026-07-01T00:00:00.000Z",
  dimension_values: { country: "US" },
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

const statsInput = {
  run_id: "run_1",
  allocation: { control: 50, treatment: 50 },
  control_variant: "control",
  decision_family: [decisionFamilyMember],
  guardrail_decisions: [],
  exposures: [exposureRow],
  metric_values: [metricRow],
  dimensions: [{ dimension_id: "country", class: "secondary", values: ["US"] }],
};

function omitField(input: Record<string, unknown>, field: string): Record<string, unknown> {
  const copy = { ...input };
  delete copy[field];
  return copy;
}

describe("DedupeExposureRowSchema", () => {
  it("requires the stats input dedupe fields", () => {
    const row = DedupeExposureRowSchema.parse(exposureRow);

    expect(row.id_type).toBe("user");
    expect(row.dimension_values?.country).toBe("US");
  });

  it.each([
    "app_id",
    "targeting_key_hash",
    "environment_id",
    "id_type",
    "run_id",
    "variant",
    "first_exposure_ts",
    "window_anchor",
  ])("rejects a missing %s field", (field) => {
    expect(DedupeExposureRowSchema.safeParse(omitField(exposureRow, field)).success).toBe(false);
  });
});

describe("PerEntityMetricRowSchema", () => {
  it("requires value and in_window for every Metric row", () => {
    expect(PerEntityMetricRowSchema.parse(metricRow).value).toBe(1);
  });

  it.each([
    "targeting_key_hash",
    "run_id",
    "metric_id",
    "metric_type",
    "value",
    "in_window",
  ])("rejects a missing %s field", (field) => {
    expect(PerEntityMetricRowSchema.safeParse(omitField(metricRow, field)).success).toBe(false);
  });

  it.each(["num_value", "denom_value"])("rejects a missing Ratio %s field", (field) => {
    expect(
      PerEntityMetricRowSchema.safeParse(
        omitField(
          {
            ...metricRow,
            metric_type: "ratio",
            num_value: 3,
            denom_value: 4,
          },
          field,
        ),
      ).success,
    ).toBe(false);
  });

  it("allows non-Ratio rows without the Ratio pair", () => {
    expect(PerEntityMetricRowSchema.safeParse(metricRow).success).toBe(true);
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
  const prePeriodRow = {
    targeting_key_hash: "tkh_1",
    metric_id: "metric_1",
    pre_period_value: 12,
    covariate_source: "pre_period",
  };

  it.each([
    "targeting_key_hash",
    "metric_id",
    "pre_period_value",
    "covariate_source",
  ])("rejects a missing %s field", (field) => {
    expect(PrePeriodRowSchema.safeParse(omitField(prePeriodRow, field)).success).toBe(false);
  });

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
  const activationRow = {
    targeting_key_hash: "tkh_1",
    run_id: "run_1",
    activation_ts: "2026-07-01T00:05:00.000Z",
    counterfactual: false,
    activated: true,
  };

  it.each([
    "targeting_key_hash",
    "run_id",
    "activation_ts",
    "counterfactual",
    "activated",
  ])("rejects a missing %s field", (field) => {
    expect(ActivationRowSchema.safeParse(omitField(activationRow, field)).success).toBe(false);
  });

  it("parses the Activation gate row fields", () => {
    const row = ActivationRowSchema.parse(activationRow);

    expect(row.activated).toBe(true);
  });
});

describe("StatsInputSchema", () => {
  it.each([
    "run_id",
    "allocation",
    "control_variant",
    "decision_family",
    "exposures",
    "metric_values",
  ])("rejects a missing %s field", (field) => {
    expect(StatsInputSchema.safeParse(omitField(statsInput, field)).success).toBe(false);
  });

  it("parses the final stats engine input shape with defaults", () => {
    const input = StatsInputSchema.parse(statsInput);

    expect(input.confidence_level).toBe(0.95);
    expect(input.horizon).toBe("sequential");
    expect(input.guardrail_decisions).toEqual([]);
    expect(input.dimensions?.[0]?.dimension_id).toBe("country");
  });

  it("requires sample_size_locked for fixed horizon input", () => {
    expect(
      StatsInputSchema.safeParse({
        ...statsInput,
        horizon: "fixed",
      }).success,
    ).toBe(false);

    expect(
      StatsInputSchema.safeParse({
        ...statsInput,
        horizon: "fixed",
        sample_size_locked: 1000,
      }).success,
    ).toBe(true);
  });

  it("requires allocation to sum to 100", () => {
    expect(
      StatsInputSchema.safeParse({
        ...statsInput,
        allocation: { control: 60, treatment: 60 },
      }).success,
    ).toBe(false);
  });

  it("parses locked Guardrail decisions", () => {
    const input = StatsInputSchema.parse({
      ...statsInput,
      guardrail_decisions: [
        {
          metric_id: "guardrail_latency",
          variant: "treatment",
          downside_threshold_pct: -5,
          guardrail_locked_at_run_start: true,
          threshold_locked_at_run_start: true,
        },
      ],
    });

    expect(input.guardrail_decisions[0]).toMatchObject({
      metric_id: "guardrail_latency",
      downside_threshold_pct: -5,
    });
  });
});
