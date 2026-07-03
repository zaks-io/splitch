import type { DecisionFamilyMember } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { applyDecisionFamilyCorrection } from "./decision-family-fdr.js";
import { armResult, resultKey } from "./decision-family-fdr-test-helpers.js";

const FAMILY: DecisionFamilyMember[] = [
  { metric_id: "goal_clicks", variant: "treatment_a" },
  { metric_id: "goal_clicks", variant: "treatment_b" },
];

describe("applyDecisionFamilyCorrection", () => {
  it("uses only the locked decision_family as m", () => {
    const output = applyDecisionFamilyCorrection({
      confidence_level: 0.95,
      decision_family: FAMILY,
      arm_results: [
        armResult("goal_clicks", "treatment_a", 0.026),
        armResult("goal_clicks", "treatment_b", 0.08),
        armResult("secondary_clicks", "treatment_a", 0.0001),
      ],
    });
    const byKey = new Map(output.arm_results.map((result) => [resultKey(result), result]));

    expect(output.summary.family_size_m).toBe(2);
    expect(byKey.get("goal_clicks/treatment_a")).toMatchObject({
      is_significant: false,
      in_bh_family: true,
      exploratory: false,
      decision_valid: true,
    });
    expect(byKey.get("goal_clicks/treatment_b")).toMatchObject({
      is_significant: false,
      in_bh_family: true,
      exploratory: false,
      decision_valid: true,
    });
    expect(byKey.get("secondary_clicks/treatment_a")).toMatchObject({
      is_significant: true,
      in_bh_family: false,
      exploratory: true,
      decision_valid: false,
    });
  });

  it("uses raw p-values in None mode", () => {
    const output = applyDecisionFamilyCorrection({
      confidence_level: 0.95,
      decision_family: [],
      arm_results: [
        armResult("secondary_clicks", "treatment_a", 0.049),
        armResult("secondary_revenue", "treatment_a", 0.05),
      ],
    });

    expect(output.summary).toMatchObject({ family_size_m: 0, rejected: [] });
    expect(output.arm_results).toEqual([
      expect.objectContaining({
        metric_id: "secondary_clicks",
        is_significant: true,
        in_bh_family: false,
        exploratory: true,
        decision_valid: false,
      }),
      expect.objectContaining({
        metric_id: "secondary_revenue",
        is_significant: false,
        in_bh_family: false,
        exploratory: true,
        decision_valid: false,
      }),
    ]);
  });

  it("keeps locked Control results decision-valid without adding them to m", () => {
    const output = applyDecisionFamilyCorrection({
      confidence_level: 0.95,
      control_variant: "control",
      decision_family: FAMILY,
      arm_results: [
        armResult("goal_clicks", "control", 0),
        armResult("goal_clicks", "treatment_a", 0.026),
        armResult("goal_clicks", "treatment_b", 0.08),
      ],
    });
    const byKey = new Map(output.arm_results.map((result) => [resultKey(result), result]));

    expect(output.summary.family_size_m).toBe(2);
    expect(byKey.get("goal_clicks/control")).toMatchObject({
      is_significant: false,
      in_bh_family: false,
      exploratory: false,
      decision_valid: true,
    });
  });

  it("fails loud when a locked family member has no ArmResult", () => {
    expect(() =>
      applyDecisionFamilyCorrection({
        confidence_level: 0.95,
        decision_family: FAMILY,
        arm_results: [armResult("goal_clicks", "treatment_a", 0.01)],
      }),
    ).toThrow(/missing locked decision_family member/);
  });

  it("fails loud on duplicate locked family results", () => {
    expect(() =>
      applyDecisionFamilyCorrection({
        confidence_level: 0.95,
        decision_family: FAMILY,
        arm_results: [
          armResult("goal_clicks", "treatment_a", 0.01),
          armResult("goal_clicks", "treatment_a", 0.02),
          armResult("goal_clicks", "treatment_b", 0.03),
        ],
      }),
    ).toThrow(/duplicate decision_family member/);
  });
});
