import { describe, expect, it } from "vitest";
import { analyzeStats } from "./stats-engine.js";
import { binomialStatsInput } from "./stats-engine-test-helpers.js";

describe("StatsEngine golden fixtures", () => {
  it("assembles a full fixed-horizon two-arm Binomial StatsOutput", async () => {
    const output = await analyzeStats(
      binomialStatsInput({
        controlN: 100,
        treatmentN: 100,
        controlConversions: 20,
        treatmentConversions: 40,
        horizon: "fixed",
        sampleSizeLocked: 100,
        includeGuardrail: true,
      }),
    );
    const conversionTreatment = output.arm_results.find(
      (result) => result.metric_id === "conversion" && result.variant === "treatment",
    );
    const guardrailTreatment = output.arm_results.find(
      (result) => result.metric_id === "guardrail_conversion" && result.variant === "treatment",
    );

    expect(output.srm).toEqual({
      srm_p_value: 1,
      srm_is_mismatch: false,
      observed_counts: { control: 100, treatment: 100 },
      expected_counts: { control: 100, treatment: 100 },
      activated_srm_p_value: null,
      activated_srm_mismatch: null,
    });
    expect(output.health).toEqual({
      multiple_rate: 0,
      multiple_count: 0,
      activation_rates: null,
      activation_balance_p_value: null,
      activation_balance_mismatch: null,
      exposure_counts: { control: 100, treatment: 100 },
      deduped_counts: { control: 100, treatment: 100 },
      low_n_warning: false,
    });

    expect(conversionTreatment).toMatchObject({
      sample_size_n: 100,
      point_estimate: 0.4,
      relative_lift_pct: 100,
      is_significant: true,
      in_bh_family: true,
      exploratory: false,
      decision_valid: true,
      status: "ready",
      variance_techniques: {
        winsorized: false,
        winsorize_pct: null,
        winsorize_cap: null,
        cuped_applied: false,
        cuped_method: "none",
        cuped_attribute: null,
        cuped_attribute_source: null,
        cuped_coverage_pct: 0,
        delta_method: false,
      },
    });
    expect(conversionTreatment?.ci_lower).toBeCloseTo(8.06954030815487, 12);
    expect(conversionTreatment?.ci_upper).toBeCloseTo(191.93045969184513, 12);
    expect(conversionTreatment?.p_value).toBeCloseTo(0.03300614049248174, 12);

    expect(guardrailTreatment?.ci_lower).toBe(conversionTreatment?.ci_lower);
    expect(output.guardrail_results).toEqual([
      {
        metric_id: "guardrail_conversion",
        variant: "treatment",
        ci_lower: guardrailTreatment?.ci_lower,
        threshold: 10,
        is_breached: true,
        in_bh_family: false,
        exploratory: false,
        decision_valid: true,
        breach_reason: `CI lower bound ${guardrailTreatment?.ci_lower} < threshold 10`,
      },
    ]);
  });
});
