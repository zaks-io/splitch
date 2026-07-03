import { describe, expect, it } from "vitest";
import { CupedCovariateRowSchema, StatsInputSchema } from "./stats-input-contract.js";

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
  metric_type: "count",
  value: 10,
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
};

describe("CUPED covariate stats input contract", () => {
  it("validates locked attribute covariates through the stats input boundary", () => {
    const result = StatsInputSchema.safeParse({
      ...statsInput,
      pre_period_covariates: [
        {
          targeting_key_hash: "tkh_1",
          metric_id: "signup_cohort",
          pre_period_value: 42,
          covariate_source: "historical_attribute",
          attribute: "signup_cohort",
          locked: true,
          attribute_source: "historical_selected",
          observed_at: "2026-06-30T00:00:00.000Z",
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it("rejects post-treatment covariate rows", () => {
    const postTreatmentRow = {
      targeting_key_hash: "tkh_1",
      metric_id: "spent_after_exposure",
      pre_period_value: 99,
      covariate_source: "post_treatment",
      attribute: "spent_after_exposure",
      locked: true,
    };

    expect(CupedCovariateRowSchema.safeParse(postTreatmentRow).success).toBe(false);
    expect(
      StatsInputSchema.safeParse({
        ...statsInput,
        pre_period_covariates: [postTreatmentRow],
      }).success,
    ).toBe(false);
  });
});
