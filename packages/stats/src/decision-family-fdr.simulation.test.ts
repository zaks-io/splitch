import { ANALYSIS_V2_VERSION, type DecisionFamilyMember } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { analysisVersionPolicy } from "./analysis-version-policy";
import { applyDecisionFamilyCorrection } from "./decision-family-fdr";
import { armResult } from "./decision-family-fdr-test-helpers";
import {
  FAMILY_FDR_SIM_ALPHA,
  FAMILY_FDR_SIM_AUDIT_LOOKS,
  FAMILY_FDR_SIM_SMOKE_LOOKS,
  runFamilyCorrectionStoppingSimulation,
} from "./decision-family-fdr-simulation";
import {
  assertGeneratedMetricCorrelation,
  FAMILY_FDR_SIM_CORRELATION,
  familyFdrSimFactorLoadings,
} from "./decision-family-fdr-simulation-correlation";
import { monteCarloTolerance } from "./sequential-ci-simulation";
import { seededNormal } from "./simulation-null-draws";

const METRIC_COUNT = 6;
const TREATMENT_VARIANTS = ["treatment_a", "treatment_b", "treatment_c", "treatment_d"] as const;
const Q = 0.1;

describe("decision_family FDR simulation smoke", () => {
  it("uses sqrt loadings so pairwise correlation matches the declared design", () => {
    const { sharedLoading, residualLoading } = familyFdrSimFactorLoadings(
      FAMILY_FDR_SIM_CORRELATION,
    );
    expect(sharedLoading).toBeCloseTo(Math.sqrt(FAMILY_FDR_SIM_CORRELATION), 12);
    expect(residualLoading).toBeCloseTo(Math.sqrt(1 - FAMILY_FDR_SIM_CORRELATION), 12);
    expect(sharedLoading ** 2).toBeCloseTo(FAMILY_FDR_SIM_CORRELATION, 12);
    // The previous 0.6 shared / 0.8 residual design realized 0.36, not 0.6.
    expect(sharedLoading).not.toBeCloseTo(FAMILY_FDR_SIM_CORRELATION, 2);
  });

  it("fails loud when generated Metric pairs miss the declared correlation", () => {
    const observed = assertGeneratedMetricCorrelation(
      seededNormal("correlation-check-pass"),
      FAMILY_FDR_SIM_CORRELATION,
      20_000,
      0.03,
    );
    expect(observed).toBeGreaterThan(FAMILY_FDR_SIM_CORRELATION - 0.03);
    expect(observed).toBeLessThan(FAMILY_FDR_SIM_CORRELATION + 0.03);

    expect(() =>
      assertGeneratedMetricCorrelation(
        seededNormal("correlation-check-fail"),
        FAMILY_FDR_SIM_CORRELATION,
        20_000,
        0,
      ),
    ).toThrow(/generated pairwise Metric correlation/);
  });

  it("controls false-discovery proportion near configured q across Metric families", () => {
    const iterations = Number.parseInt(
      process.env.SPLITCH_STATS_SIMULATION_ITERATIONS ?? "300",
      10,
    );
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
    expect(observedFdr).toBeLessThanOrEqual(Q + oneLookTolerance(Q, iterations));
  });

  it("records BH and BH-G FDR and power under stop-at-first-crossing correlated mixed nulls", {
    timeout: 120_000,
  }, () => {
    const mode = process.env.SPLITCH_STATS_SIMULATION_MODE === "audit" ? "audit" : "smoke";
    const seed = process.env.SPLITCH_STATS_SIMULATION_SEED ?? "424242";
    const iterations = Number.parseInt(
      process.env.SPLITCH_STATS_SIMULATION_ITERATIONS ?? "300",
      10,
    );
    const lookSchedule = mode === "audit" ? FAMILY_FDR_SIM_AUDIT_LOOKS : FAMILY_FDR_SIM_SMOKE_LOOKS;
    const result = runFamilyCorrectionStoppingSimulation({
      seed,
      iterations,
      lookSchedule,
    });
    const tolerance = monteCarloTolerance(FAMILY_FDR_SIM_ALPHA, iterations);

    console.info(
      `family FDR ${mode} seed=${seed} iterations=${iterations} ` +
        `bhFdr=${result.bh.observedFdr} bhGFdr=${result.bh_g.observedFdr} ` +
        `bhStopPower=${result.bh.power} bhGStopPower=${result.bh_g.power} ` +
        `stopPowerCost=${result.stopPowerCost} ` +
        `bhLastLookPower=${result.lastLookBh.power} bhGLastLookPower=${result.lastLookBhG.power} ` +
        `lastLookPowerCost=${result.lastLookPowerCost} tolerance=${tolerance}`,
    );

    // Assert FDR for the procedure analysis-v2 selects (BH-G), not plain BH.
    const selected = analysisVersionPolicy(ANALYSIS_V2_VERSION).familyCorrection;
    expect(result[selected].observedFdr).toBeLessThanOrEqual(FAMILY_FDR_SIM_ALPHA + tolerance);
    expect(result.lastLookBhG.power).toBeLessThanOrEqual(result.lastLookBh.power + Number.EPSILON);
    expect(result.lastLookPowerCost).toBeGreaterThanOrEqual(-Number.EPSILON);
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

function oneLookTolerance(q: number, iterations: number): number {
  return 3 * Math.sqrt((q * (1 - q)) / iterations) + 0.03;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
