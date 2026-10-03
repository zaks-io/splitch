import { describe, expect, it } from "vitest";
import { armResult, stats } from "./experiment-decision-gate-test-fixtures";
import { beneficialArm, preReg, recommend } from "./ship-recommendation-test-fixtures";

describe("computeShipRecommendation FDR evidence", () => {
  it("does not ship when the primary clears the margin but fails FDR correction", () => {
    const output = stats({
      arm_results: [
        beneficialArm({
          is_significant: false,
          in_bh_family: true,
          decision_valid: true,
        }),
      ],
    });
    const result = recommend(output);
    expect(result.recommendation?.verdict).toBe("keep_running");
    expect(result.recommendation?.verdict).not.toBe("ship");
  });

  it("does not ship a Multi-Metric win when a family member fails FDR", () => {
    const output = stats({
      arm_results: [
        beneficialArm({ metric_id: "checkout-conversion" }),
        beneficialArm({
          metric_id: "secondary-goal",
          is_significant: false,
          in_bh_family: true,
          decision_valid: true,
        }),
      ],
    });
    const result = recommend(
      output,
      preReg({
        metrics: [
          { metric_id: "checkout-conversion", desirability: "higher_is_better" },
          { metric_id: "secondary-goal", desirability: "higher_is_better" },
        ],
        ship_rule: {
          required_margin: 0.02,
          margin_scale: "absolute",
          conflict_resolution: "unanimous_goals",
        },
      }),
    );
    expect(result.recommendation?.verdict).toBe("keep_running");
  });
});

describe("computeShipRecommendation Guardrails vs goals", () => {
  it("ignores a Guardrail Metric under unanimous_goals", () => {
    const output = stats({
      arm_results: [
        beneficialArm({ metric_id: "checkout-conversion" }),
        armResult({
          metric_id: "metric_guard",
          absolute_ci_lower: -0.05,
          absolute_ci_upper: -0.01,
          ci_lower: -20,
          ci_upper: -5,
          relative_lift_pct: -10,
          in_bh_family: false,
          is_significant: false,
          decision_valid: false,
          exploratory: true,
        }),
      ],
      guardrail_results: [
        {
          metric_id: "metric_guard",
          variant: "treatment",
          ci_lower: -8,
          threshold: -10,
          is_breached: false,
          in_bh_family: false,
          exploratory: false,
          decision_valid: true,
          breach_reason: null,
        },
      ],
    });
    const result = recommend(
      output,
      preReg({
        metrics: [
          { metric_id: "checkout-conversion", desirability: "higher_is_better" },
          { metric_id: "metric_guard", desirability: "lower_is_better" },
        ],
        ship_rule: {
          required_margin: 0.02,
          margin_scale: "absolute",
          conflict_resolution: "unanimous_goals",
        },
      }),
    );
    expect(result.recommendation?.verdict).toBe("ship");
  });

  it("ignores a Guardrail Metric under any_goal", () => {
    const output = stats({
      arm_results: [
        armResult({
          metric_id: "checkout-conversion",
          absolute_ci_lower: -0.01,
          absolute_ci_upper: 0.04,
          ci_lower: -2,
          ci_upper: 8,
          relative_lift_pct: 3,
        }),
        beneficialArm({ metric_id: "secondary-goal" }),
        armResult({
          metric_id: "metric_guard",
          absolute_ci_lower: 0.03,
          absolute_ci_upper: 0.08,
          in_bh_family: false,
          is_significant: true,
          decision_valid: false,
          exploratory: true,
        }),
      ],
      guardrail_results: [
        {
          metric_id: "metric_guard",
          variant: "treatment",
          ci_lower: -2,
          threshold: -10,
          is_breached: false,
          in_bh_family: false,
          exploratory: false,
          decision_valid: true,
          breach_reason: null,
        },
      ],
    });
    const result = recommend(
      output,
      preReg({
        metrics: [
          { metric_id: "checkout-conversion", desirability: "higher_is_better" },
          { metric_id: "secondary-goal", desirability: "higher_is_better" },
          { metric_id: "metric_guard", desirability: "lower_is_better" },
        ],
        ship_rule: {
          required_margin: 0.02,
          margin_scale: "absolute",
          conflict_resolution: "any_goal",
        },
      }),
    );
    expect(result.recommendation?.verdict).toBe("ship");
    expect(result.recommendation?.because).toMatch(/Goal Metric/);
  });

  it("explains do_not_ship from a harmful secondary goal, not the beneficial primary", () => {
    const output = stats({
      arm_results: [
        beneficialArm({ metric_id: "checkout-conversion" }),
        armResult({
          metric_id: "secondary-goal",
          absolute_ci_lower: -0.08,
          absolute_ci_upper: -0.03,
          ci_lower: -15,
          ci_upper: -5,
          relative_lift_pct: -10,
        }),
      ],
    });
    const result = recommend(
      output,
      preReg({
        metrics: [
          { metric_id: "checkout-conversion", desirability: "higher_is_better" },
          { metric_id: "secondary-goal", desirability: "higher_is_better" },
        ],
        ship_rule: {
          required_margin: 0.02,
          margin_scale: "absolute",
          conflict_resolution: "unanimous_goals",
        },
      }),
    );
    expect(result.recommendation?.verdict).toBe("do_not_ship");
    expect(result.recommendation?.because).toMatch(/Goal Metric/);
    expect(result.recommendation?.because).toMatch(/\[-0\.08/);
    expect(result.recommendation?.because).not.toMatch(/\[0\.03/);
  });
});
