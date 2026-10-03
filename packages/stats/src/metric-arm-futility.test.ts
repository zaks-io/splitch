import { describe, expect, it } from "vitest";
import { withFutilityVerdict } from "./metric-arm-futility";
import type { CIResult } from "./sequential-ci";

const armBase = {
  variant: "treatment",
  metric_id: "metric_goal",
  sample_size_n: 200,
  point_estimate: 0.12,
  relative_lift_pct: 20,
  ci_lower: 5,
  ci_upper: 35,
  p_value: 0.01,
  is_significant: false,
  in_bh_family: true,
  exploratory: false,
  decision_valid: true,
  status: "ready" as const,
  variance_techniques: {
    winsorized: false,
    winsorize_pct: null,
    winsorize_cap: null,
    cuped_applied: false,
    cuped_method: null,
    cuped_attribute: null,
    cuped_attribute_source: null,
    cuped_coverage_pct: null,
    delta_method: true,
  },
};

const finiteDecisionCi: CIResult = {
  ci_lower: -0.01,
  ci_upper: 0.01,
  p_value: 0.4,
  mode: "sequential",
  status: "ok",
  source: {
    family: "normal-mixture-asymptotic-confidence-sequence",
    references: [],
  },
  n: 200,
  peeking_allowed: true,
  target_n: 5000,
  boundary: 1.96,
};

const mdeExclusionPreRegistration = {
  hypothesis: "Treatment raises the goal by at least 2pp",
  primary_metric_id: "metric_goal",
  metrics: [
    {
      metric_id: "metric_goal",
      desirability: "higher_is_better" as const,
      mde_absolute: 0.02,
    },
  ],
  ship_rule: {
    required_margin: 0.02,
    margin_scale: "absolute" as const,
    conflict_resolution: "primary_wins" as const,
  },
  futility: "mde_exclusion" as const,
};

describe("withFutilityVerdict", () => {
  it("omits futility fields when pre-registration is absent", () => {
    const arm = withFutilityVerdict(armBase, {
      preRegistration: undefined,
      decisionCi: finiteDecisionCi,
    });
    expect(arm.futilityVerdict).toBeUndefined();
    expect(arm.futilityBecause).toBeUndefined();
  });

  it("omits futility fields when futility is off", () => {
    const arm = withFutilityVerdict(armBase, {
      preRegistration: { ...mdeExclusionPreRegistration, futility: "off" },
      decisionCi: finiteDecisionCi,
    });
    expect(arm.futilityVerdict).toBeUndefined();
    expect(arm.futilityBecause).toBeUndefined();
  });

  it("omits futility fields for a non-primary Metric", () => {
    const arm = withFutilityVerdict(
      { ...armBase, metric_id: "metric_other" },
      {
        preRegistration: mdeExclusionPreRegistration,
        decisionCi: finiteDecisionCi,
      },
    );
    expect(arm.futilityVerdict).toBeUndefined();
  });

  it("classifies futile when the beneficial-side bound excludes the MDE", () => {
    const arm = withFutilityVerdict(armBase, {
      preRegistration: mdeExclusionPreRegistration,
      decisionCi: finiteDecisionCi,
    });
    expect(arm.futilityVerdict).toBe("futile");
    expect(arm.futilityBecause).toMatch(/upper bound/);
  });

  it("omits futility fields when the absolute decision interval is not finite", () => {
    const arm = withFutilityVerdict(armBase, {
      preRegistration: mdeExclusionPreRegistration,
      decisionCi: {
        ...finiteDecisionCi,
        ci_lower: Number.NEGATIVE_INFINITY,
        ci_upper: Number.POSITIVE_INFINITY,
      },
    });
    expect(arm.futilityVerdict).toBeUndefined();
    expect(arm.futilityBecause).toBeUndefined();
  });
});
