import { describe, expect, it } from "vitest";
import { armResult, stats } from "./experiment-decision-gate-test-fixtures";
import { beneficialArm, preReg, recommend } from "./ship-recommendation-test-fixtures";

function positiveControlArm(overrides: Parameters<typeof armResult>[0] = {}) {
  return armResult({
    variant: "control",
    point_estimate: 0.4,
    relative_lift_pct: null,
    absolute_ci_lower: undefined,
    absolute_ci_upper: undefined,
    ci_lower: null,
    ci_upper: null,
    is_significant: false,
    in_bh_family: false,
    decision_valid: false,
    ...overrides,
  });
}

function relativeShipRule(
  desirability: "higher_is_better" | "lower_is_better" = "higher_is_better",
) {
  return preReg({
    metrics: [{ metric_id: "checkout-conversion", desirability }],
    ship_rule: {
      required_margin: 0.02,
      margin_scale: "relative",
      conflict_resolution: "primary_wins",
    },
  });
}

describe("computeShipRecommendation interval scales and Control identity", () => {
  it("fails loud with absolute_interval_unavailable when absolute CI is missing", () => {
    const output = stats({
      arm_results: [
        armResult({
          ci_lower: 5,
          ci_upper: 15,
          relative_lift_pct: 10,
        }),
      ],
    });
    expect(recommend(output)).toEqual({
      recommendationUnavailable: "absolute_interval_unavailable",
    });
  });

  it("uses relative CI on a fixed-horizon Run", () => {
    const output = stats({
      arm_results: [
        positiveControlArm(),
        armResult({
          ci_lower: 5,
          ci_upper: 15,
          relative_lift_pct: 10,
        }),
      ],
    });
    const result = recommend(output, relativeShipRule(), "fixed");
    expect(result.recommendation?.verdict).toBe("ship");
    expect(result.recommendation?.because).toMatch(/2%/);
  });

  it("returns relative_sequential_coverage_unproven for sequential + relative", () => {
    const output = stats({
      arm_results: [
        positiveControlArm(),
        armResult({
          ci_lower: 5,
          ci_upper: 15,
          relative_lift_pct: 10,
        }),
      ],
    });
    expect(recommend(output, relativeShipRule(), "sequential")).toEqual({
      recommendationUnavailable: "relative_sequential_coverage_unproven",
    });
  });

  it("ships an absolute rule when relative lift is null (zero Control mean)", () => {
    const output = stats({
      arm_results: [
        armResult({
          variant: "control",
          relative_lift_pct: null,
          absolute_ci_lower: undefined,
          absolute_ci_upper: undefined,
          ci_lower: null,
          ci_upper: null,
          is_significant: false,
          in_bh_family: false,
          decision_valid: false,
        }),
        beneficialArm({
          relative_lift_pct: null,
        }),
      ],
    });
    const result = recommend(output);
    expect(result.recommendation?.verdict).toBe("ship");
    expect(result.recommendationUnavailable).toBeUndefined();
  });

  it.each([
    {
      desirability: "higher_is_better" as const,
      // Control -12, Treatment -15 → absolute harm, but relative lift +25%.
      controlMean: -12,
      treatmentMean: -15,
      ci_lower: 20,
      ci_upper: 30,
      relative_lift_pct: 25,
    },
    {
      desirability: "lower_is_better" as const,
      // Control -12, Treatment -9 → absolute harm for lower_is_better, but
      // relative lift -25% looks beneficial on the relative scale.
      controlMean: -12,
      treatmentMean: -9,
      ci_lower: -30,
      ci_upper: -20,
      relative_lift_pct: -25,
    },
  ])(
    "returns relative_control_mean_non_positive for $desirability with negative Control",
    ({ desirability, controlMean, treatmentMean, ci_lower, ci_upper, relative_lift_pct }) => {
      const output = stats({
        arm_results: [
          positiveControlArm({ point_estimate: controlMean }),
          armResult({
            point_estimate: treatmentMean,
            ci_lower,
            ci_upper,
            relative_lift_pct,
            absolute_ci_lower: treatmentMean - controlMean - 0.01,
            absolute_ci_upper: treatmentMean - controlMean + 0.01,
          }),
        ],
      });
      expect(recommend(output, relativeShipRule(desirability), "fixed")).toEqual({
        recommendationUnavailable: "relative_control_mean_non_positive",
      });
    },
  );

  it("returns relative_control_mean_non_positive for a zero Control mean", () => {
    const output = stats({
      arm_results: [
        positiveControlArm({ point_estimate: 0 }),
        armResult({
          ci_lower: 5,
          ci_upper: 15,
          relative_lift_pct: null,
        }),
      ],
    });
    expect(recommend(output, relativeShipRule(), "fixed")).toEqual({
      recommendationUnavailable: "relative_control_mean_non_positive",
    });
  });
});
