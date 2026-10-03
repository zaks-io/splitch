import { describe, expect, it } from "vitest";
import { armResult, stats } from "./experiment-decision-gate-test-fixtures";
import { beneficialArm, preReg, recommend } from "./ship-recommendation-test-fixtures";

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
        armResult({
          ci_lower: 5,
          ci_upper: 15,
          relative_lift_pct: 10,
        }),
      ],
    });
    const result = recommend(
      output,
      preReg({
        ship_rule: {
          required_margin: 0.02,
          margin_scale: "relative",
          conflict_resolution: "primary_wins",
        },
      }),
      "fixed",
    );
    expect(result.recommendation?.verdict).toBe("ship");
    expect(result.recommendation?.because).toMatch(/2%/);
  });

  it("returns relative_sequential_coverage_unproven for sequential + relative", () => {
    const output = stats({
      arm_results: [
        armResult({
          ci_lower: 5,
          ci_upper: 15,
          relative_lift_pct: 10,
        }),
      ],
    });
    expect(
      recommend(
        output,
        preReg({
          ship_rule: {
            required_margin: 0.02,
            margin_scale: "relative",
            conflict_resolution: "primary_wins",
          },
        }),
        "sequential",
      ),
    ).toEqual({ recommendationUnavailable: "relative_sequential_coverage_unproven" });
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
});
