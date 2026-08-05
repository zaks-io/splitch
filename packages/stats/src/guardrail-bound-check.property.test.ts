import type { DecisionFamilyMember } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { applyDecisionFamilyCorrection } from "./decision-family-fdr";
import { armResult } from "./decision-family-fdr-test-helpers";
import { applyGuardrailBoundChecks } from "./guardrail-bound-check";

const ITERATIONS = 100;

describe("guardrail bound check metamorphic properties", () => {
  it("keeps is_breached invariant when the BH family changes", () => {
    const random = seededRandom(774_049);
    const decisionFamily = familyMembers(6);

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const ciLower = randomBetween(random, -8, 4);
      const ciUpper = ciLower + randomBetween(random, 0.1, 10);
      const threshold = randomBetween(random, -6, 2);
      const guardrailArm = armResult("guardrail_latency", "treatment", random(), {
        relative_lift_pct: randomBetween(random, ciLower, ciUpper),
        ci_lower: ciLower,
        ci_upper: ciUpper,
      });
      const withoutFamily = applyDecisionFamilyCorrection({
        confidence_level: 0.95,
        decision_family: [],
        arm_results: [guardrailArm],
      });
      const withFamily = applyDecisionFamilyCorrection({
        confidence_level: 0.95,
        decision_family: decisionFamily,
        arm_results: [
          ...decisionFamily.map((member) => armResult(member.metric_id, member.variant, random())),
          guardrailArm,
        ],
      });

      expect(guardrailResult(withoutFamily.arm_results, threshold).is_breached).toBe(
        guardrailResult(withFamily.arm_results, threshold).is_breached,
      );
      expect(withFamily.summary.family_size_m).toBe(decisionFamily.length);
    }
  });

  it("keeps a breached CI breached when the lower-bound threshold is tightened", () => {
    const random = seededRandom(419_522);

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const ciLower = randomBetween(random, -10, 10);
      const threshold = ciLower + randomBetween(random, 0.01, 10);
      const tightenedThreshold = threshold + randomBetween(random, 0.01, 10);

      expect(guardrailResult([boundArm(ciLower)], threshold).is_breached).toBe(true);
      expect(guardrailResult([boundArm(ciLower)], tightenedThreshold).is_breached).toBe(true);
    }
  });

  it("sets is_breached to null iff relative lift is null", () => {
    const random = seededRandom(920_118);

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const relativeLiftIsNull = random() < 0.5;
      const result = guardrailResult([relativeLiftArm(random, relativeLiftIsNull)], -0.5);

      expect(result.is_breached === null).toBe(relativeLiftIsNull);
    }
  });
});

function guardrailResult(
  armResults: Parameters<typeof applyGuardrailBoundChecks>[0]["arm_results"],
  threshold: number,
) {
  const [result] = applyGuardrailBoundChecks({
    arm_results: armResults,
    guardrails: [
      {
        metric_id: "guardrail_latency",
        variant: "treatment",
        downside_threshold_pct: threshold,
        guardrail_locked_at_run_start: true,
        threshold_locked_at_run_start: true,
      },
    ],
  });
  if (result === undefined) {
    throw new Error("test fixture guardrail result missing");
  }
  return result;
}

function boundArm(ciLower: number) {
  return armResult("guardrail_latency", "treatment", 0.8, {
    relative_lift_pct: ciLower + 5,
    ci_lower: ciLower,
    ci_upper: ciLower + 10,
  });
}

function relativeLiftArm(random: () => number, relativeLiftIsNull: boolean) {
  if (relativeLiftIsNull) {
    return armResult("guardrail_latency", "treatment", random(), {
      relative_lift_pct: null,
      ci_lower: null,
      ci_upper: null,
    });
  }

  const ciLower = randomBetween(random, -8, 4);
  const ciUpper = randomBetween(random, 5, 15);
  return armResult("guardrail_latency", "treatment", random(), {
    relative_lift_pct: randomBetween(random, ciLower, ciUpper),
    ci_lower: ciLower,
    ci_upper: ciUpper,
  });
}

function familyMembers(count: number): DecisionFamilyMember[] {
  return Array.from({ length: count }, (_, index) => ({
    metric_id: `goal_${index}`,
    variant: index % 2 === 0 ? "treatment_a" : "treatment_b",
  }));
}

function randomBetween(random: () => number, min: number, max: number): number {
  return min + random() * (max - min);
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
