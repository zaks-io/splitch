import { describe, expect, it } from "vitest";
import { computeCohortEffect } from "./cohort-effect";
import { COHORT_RUN_START, type CohortEntitySpec, cohortStatsInput } from "./cohort-effect-cases";
import { COHORT_EFFECT_NOVELTY_ALPHA } from "./cohort-effect-types";
import { seededUniform } from "./relative-ci-simulation-draws";

/**
 * Seeded Monte Carlo for the novelty flag (plan 2.8 Done shape):
 * - null (constant effect across arrival days) → flag rate within alpha + tolerance
 * - decaying early effect → flag fires
 */

const SIM_SEED = "cohort-effect-novelty:v1";
const ITERATIONS = 400;
const PER_ARM_PER_DAY = 40;
const DAY_OFFSETS = [0, 3, 10] as const;
/** Monte Carlo tolerance above alpha for the null flag rate. */
const NULL_TOLERANCE = 0.04;

describe("cohort-effect novelty simulation", () => {
  it("null constant effect keeps novelty flag rate within alpha + tolerance", () => {
    const uniform = seededUniform(`${SIM_SEED}:null`);
    let flagged = 0;
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const entities = drawBinomialEntities({
        uniform,
        controlRate: 0.2,
        treatmentRate: 0.25,
        earlyTreatmentRate: 0.25,
      });
      const diagnostic = computeCohortEffect({
        statsInput: cohortStatsInput(entities),
        runStartedAt: COHORT_RUN_START,
        minArmN: 30,
      });
      if (diagnostic.state !== "ready") {
        throw new Error(`expected ready diagnostic on iteration ${iteration}`);
      }
      if (diagnostic.comparisons[0]?.novelty.flag === "detected") {
        flagged += 1;
      }
    }
    const rate = flagged / ITERATIONS;
    expect(rate).toBeLessThanOrEqual(COHORT_EFFECT_NOVELTY_ALPHA + NULL_TOLERANCE);
  });

  it("injected decaying early effect fires the novelty flag", () => {
    const uniform = seededUniform(`${SIM_SEED}:decay`);
    const entities = drawBinomialEntities({
      uniform,
      controlRate: 0.2,
      treatmentRate: 0.22,
      earlyTreatmentRate: 0.55,
    });
    const diagnostic = computeCohortEffect({
      statsInput: cohortStatsInput(entities),
      runStartedAt: COHORT_RUN_START,
      minArmN: 30,
    });
    expect(diagnostic.state).toBe("ready");
    if (diagnostic.state !== "ready") throw new Error("expected ready");
    expect(diagnostic.comparisons[0]?.novelty.flag).toBe("detected");
  });
});

function drawBinomialEntities(args: {
  uniform: () => number;
  controlRate: number;
  treatmentRate: number;
  earlyTreatmentRate: number;
}): CohortEntitySpec[] {
  const entities: CohortEntitySpec[] = [];
  for (const dayOffset of DAY_OFFSETS) {
    entities.push(
      ...armEntitiesForDay({
        dayOffset,
        uniform: args.uniform,
        controlRate: args.controlRate,
        treatmentRate: treatmentRateForDay(dayOffset, args.earlyTreatmentRate, args.treatmentRate),
      }),
    );
  }
  return entities;
}

function treatmentRateForDay(
  dayOffset: number,
  earlyTreatmentRate: number,
  treatmentRate: number,
): number {
  return dayOffset === 0 ? earlyTreatmentRate : treatmentRate;
}

function armEntitiesForDay(args: {
  dayOffset: number;
  uniform: () => number;
  controlRate: number;
  treatmentRate: number;
}): CohortEntitySpec[] {
  const entities: CohortEntitySpec[] = [];
  for (let index = 0; index < PER_ARM_PER_DAY; index += 1) {
    entities.push({
      variant: "control",
      dayOffset: args.dayOffset,
      index,
      value: args.uniform() < args.controlRate ? 1 : 0,
    });
    entities.push({
      variant: "treatment",
      dayOffset: args.dayOffset,
      index,
      value: args.uniform() < args.treatmentRate ? 1 : 0,
    });
  }
  return entities;
}
