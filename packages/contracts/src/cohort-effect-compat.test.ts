import { describe, expect, it } from "vitest";
import { CohortEffectDiagnosticSchema } from "./cohort-effect";
import { AnalysisResultsEnvelopeSchema } from "./stats-result-contract";

/**
 * Deploy-order compat: Analysis can emit cohort_effect before Control Plane
 * deploys, and Control Plane can deploy before Analysis emits it. .strict()
 * AnalysisResultsEnvelopeSchema must accept both shapes.
 */

const readyBucket = {
  bucket: "day_0" as const,
  n_control: 40,
  n_treatment: 40,
  absolute_effect: 0.02,
  absolute_ci_lower: -0.01,
  absolute_ci_upper: 0.05,
  status: "ready" as const,
};

const readyDiagnostic = {
  state: "ready" as const,
  metric_id: "conversion",
  grouping: "first_exposure_day_vs_run_start" as const,
  comparisons: [
    {
      treatment_variant: "treatment",
      buckets: [
        readyBucket,
        { ...readyBucket, bucket: "days_1_6" as const },
        { ...readyBucket, bucket: "day_7_plus" as const },
      ],
      novelty: { flag: "not_detected" as const, alpha: 0.05 },
    },
  ],
};

const envelopeBase = {
  state: "ready" as const,
  run_id: "run_cohort_compat",
  control_variant: "control",
  stats: {
    arm_results: [],
    srm: {
      srm_p_value: 1,
      srm_is_mismatch: false,
      observed_counts: { control: 10, treatment: 10 },
      expected_counts: { control: 10, treatment: 10 },
      activated_srm_p_value: null,
      activated_srm_mismatch: null,
    },
    guardrail_results: [],
    health: {
      multiple_rate: 0,
      multiple_count: 0,
      activation_rates: null,
      activation_balance_p_value: null,
      activation_balance_mismatch: null,
      exposure_counts: { control: 10, treatment: 10 },
      deduped_counts: { control: 10, treatment: 10 },
      low_n_warning: true,
    },
  },
};

describe("cohort_effect deploy compatibility", () => {
  it("accepts a ready Analysis envelope carrying cohort_effect", () => {
    const envelope = AnalysisResultsEnvelopeSchema.parse({
      ...envelopeBase,
      cohort_effect: readyDiagnostic,
    });
    expect(envelope.state).toBe("ready");
    if (envelope.state !== "ready") throw new Error("expected ready");
    expect(envelope.cohort_effect).toEqual(readyDiagnostic);
  });

  it("accepts a ready Analysis envelope without cohort_effect", () => {
    const envelope = AnalysisResultsEnvelopeSchema.parse(envelopeBase);
    expect(envelope.state).toBe("ready");
    if (envelope.state !== "ready") throw new Error("expected ready");
    expect(envelope.cohort_effect).toBeUndefined();
  });

  it("accepts unavailable cohort_effect with an explicit reason", () => {
    const diagnostic = CohortEffectDiagnosticSchema.parse({
      state: "unavailable",
      reason: "insufficient_entities",
    });
    expect(diagnostic).toEqual({ state: "unavailable", reason: "insufficient_entities" });
  });

  it.each(["zero_variance", "insufficient_denominator", "numerical_failure"] as const)(
    "accepts a %s bucket with no interval",
    (status) => {
      const bucket = {
        ...readyBucket,
        absolute_ci_lower: null,
        absolute_ci_upper: null,
        status,
      };
      const envelope = AnalysisResultsEnvelopeSchema.parse({
        ...envelopeBase,
        cohort_effect: {
          ...readyDiagnostic,
          comparisons: [{ ...readyDiagnostic.comparisons[0], buckets: [bucket, bucket, bucket] }],
        },
      });
      expect(envelope.state).toBe("ready");
    },
  );

  it("rejects an unknown unavailable reason (fail loud)", () => {
    expect(() =>
      CohortEffectDiagnosticSchema.parse({
        state: "unavailable",
        reason: "silently_skipped",
      }),
    ).toThrow();
  });

  it("accepts zero_variance and insufficient_denominator bucket statuses", () => {
    const diagnostic = CohortEffectDiagnosticSchema.parse({
      ...readyDiagnostic,
      comparisons: [
        {
          treatment_variant: "treatment",
          buckets: [
            {
              ...readyBucket,
              status: "zero_variance",
              absolute_ci_lower: null,
              absolute_ci_upper: null,
            },
            {
              ...readyBucket,
              bucket: "days_1_6",
              status: "insufficient_denominator",
              absolute_effect: null,
              absolute_ci_lower: null,
              absolute_ci_upper: null,
            },
            { ...readyBucket, bucket: "day_7_plus", status: "insufficient_n" },
          ],
          novelty: { flag: "insufficient_data", alpha: 0.05 },
        },
      ],
    });
    expect(diagnostic.state).toBe("ready");
  });
});
