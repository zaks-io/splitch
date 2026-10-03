import { describe, expect, it } from "vitest";
import { withRopeVerdict } from "./metric-arm-rope";
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

const preRegistration = {
  hypothesis: "Treatment raises the goal",
  primary_metric_id: "metric_goal",
  metrics: [
    {
      metric_id: "metric_goal",
      desirability: "higher_is_better" as const,
      rope: { lower: -0.01, upper: 0.01, scale: "absolute" as const },
    },
  ],
  ship_rule: {
    required_margin: 0.02,
    margin_scale: "absolute" as const,
    conflict_resolution: "primary_wins" as const,
  },
};

const finiteDecisionCi: CIResult = {
  ci_lower: -0.02,
  ci_upper: 0.12,
  p_value: 0.2,
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

describe("withRopeVerdict", () => {
  it("omits ropeVerdict when pre-registration is absent", () => {
    const arm = withRopeVerdict(armBase, {
      preRegistration: undefined,
      decisionCi: finiteDecisionCi,
      relativeLower: 5,
      relativeUpper: 35,
    });
    expect(arm.ropeVerdict).toBeUndefined();
    expect(arm.ropeScale).toBeUndefined();
  });

  it("classifies an absolute ROPE against the decision interval", () => {
    const arm = withRopeVerdict(armBase, {
      preRegistration,
      decisionCi: finiteDecisionCi,
      relativeLower: 5,
      relativeUpper: 35,
    });
    expect(arm.ropeVerdict).toBe("undecided");
    expect(arm.ropeScale).toBe("absolute");
  });

  it("omits ropeVerdict when the decision interval is not finite", () => {
    const arm = withRopeVerdict(armBase, {
      preRegistration,
      decisionCi: {
        ...finiteDecisionCi,
        ci_lower: Number.NEGATIVE_INFINITY,
        ci_upper: Number.POSITIVE_INFINITY,
      },
      relativeLower: 5,
      relativeUpper: 35,
    });
    expect(arm.ropeVerdict).toBeUndefined();
  });
});
