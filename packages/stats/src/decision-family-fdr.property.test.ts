import type { ArmResult, DecisionFamilyMember } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { applyDecisionFamilyCorrection } from "./decision-family-fdr.js";
import { armResult, resultKey } from "./decision-family-fdr-test-helpers.js";

const FAMILY_SIZE = 8;
const ITERATIONS = 100;

describe("decision_family FDR metamorphic properties", () => {
  it("keeps locked significance stable when a Secondary Metric is added post-start", () => {
    const random = seededRandom(481_048);

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const pValues = Array.from({ length: FAMILY_SIZE }, () => random());
      const decisionFamily = familyMembers(FAMILY_SIZE);
      const lockedResults = decisionFamily.map((member, index) =>
        armResult(member.metric_id, member.variant, pValues[index] ?? 1),
      );
      const before = applyDecisionFamilyCorrection({
        confidence_level: 0.95,
        decision_family: decisionFamily,
        arm_results: lockedResults,
      });
      const after = applyDecisionFamilyCorrection({
        confidence_level: 0.95,
        decision_family: decisionFamily,
        arm_results: [armResult(`secondary_${iteration}`, "treatment", 0), ...lockedResults],
      });

      expect(significanceByKey(after.arm_results)).toMatchObject(
        significanceByKey(before.arm_results),
      );
      expect(after.summary.family_size_m).toBe(before.summary.family_size_m);
      expect(after.arm_results[0]).toMatchObject({
        metric_id: `secondary_${iteration}`,
        in_bh_family: false,
        exploratory: true,
        decision_valid: false,
      });
    }
  });

  it("keeps locked significance stable when a Secondary Dimension is added post-start", () => {
    const random = seededRandom(944_519);

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const pValues = Array.from({ length: FAMILY_SIZE }, () => random());
      const decisionFamily = familyMembers(FAMILY_SIZE);
      const lockedResults = decisionFamily.map((member, index) =>
        armResult(member.metric_id, member.variant, pValues[index] ?? 1),
      );
      const secondaryDimension = {
        ...armResult("goal_0", "treatment_a", 0),
        dimension_id: `post_start_${iteration}`,
        dimension_value: "new_value",
      };
      const before = applyDecisionFamilyCorrection({
        confidence_level: 0.95,
        decision_family: decisionFamily,
        arm_results: lockedResults,
      });
      const after = applyDecisionFamilyCorrection({
        confidence_level: 0.95,
        decision_family: decisionFamily,
        arm_results: [secondaryDimension, ...lockedResults],
      });

      expect(significanceByKey(after.arm_results)).toMatchObject(
        significanceByKey(before.arm_results),
      );
      expect(after.summary.family_size_m).toBe(before.summary.family_size_m);
      expect(after.arm_results[0]).toMatchObject({
        dimension_id: `post_start_${iteration}`,
        dimension_value: "new_value",
        in_bh_family: false,
        exploratory: true,
        decision_valid: false,
      });
    }
  });
});

function familyMembers(count: number): DecisionFamilyMember[] {
  return Array.from({ length: count }, (_, index) => ({
    metric_id: `goal_${index}`,
    variant: index % 2 === 0 ? "treatment_a" : "treatment_b",
  }));
}

function significanceByKey(results: readonly ArmResult[]): Record<string, boolean> {
  return Object.fromEntries(
    results
      .filter((result) => result.in_bh_family)
      .map((result) => [resultKey(result), result.is_significant]),
  );
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
