import type { DecisionFamilyMember } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { applyDecisionFamilyCorrection } from "./decision-family-fdr";
import { armResult } from "./decision-family-fdr-test-helpers";

const METRIC_COUNT = 6;
const TREATMENT_VARIANTS = ["treatment_a", "treatment_b", "treatment_c", "treatment_d"] as const;
const Q = 0.1;

describe("decision_family FDR simulation smoke", () => {
  it("controls false-discovery proportion near configured q across Metric families", () => {
    const iterations = Number.parseInt(process.env.SPLITCH_STATS_SIMULATION_ITERATIONS ?? "25", 10);
    const seed = Number.parseInt(process.env.SPLITCH_STATS_SIMULATION_SEED ?? "424242", 10);
    const random = seededRandom(seed);
    const decisionFamily = metricFamily();
    let falseDiscoveryProportionSum = 0;

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const output = applyDecisionFamilyCorrection({
        confidence_level: 1 - Q,
        decision_family: decisionFamily,
        arm_results: decisionFamily.map((member) =>
          armResult(member.metric_id, member.variant, random()),
        ),
      });
      const falseDiscoveries = output.arm_results.filter((result) => result.is_significant).length;

      falseDiscoveryProportionSum += falseDiscoveries > 0 ? 1 : 0;
    }

    const observedFdr = falseDiscoveryProportionSum / iterations;
    expect(observedFdr).toBeLessThanOrEqual(Q + monteCarloTolerance(Q, iterations));
  });
});

function metricFamily(): DecisionFamilyMember[] {
  return Array.from({ length: METRIC_COUNT }, (_, metricIndex) =>
    TREATMENT_VARIANTS.map((variant) => ({
      metric_id: `metric_${metricIndex}`,
      variant,
    })),
  ).flat();
}

function monteCarloTolerance(q: number, iterations: number): number {
  return 3 * Math.sqrt((q * (1 - q)) / iterations) + 0.03;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
