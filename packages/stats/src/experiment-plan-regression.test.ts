import { describe, expect, it } from "vitest";
import { planExperiment } from "./experiment-plan";
import { armVariances, comparisonPower } from "./experiment-plan-power";

describe("planExperiment binomial MDE regressions", () => {
  it("solves fixed-size binomial MDE when an intermediate estimate exits (0, 1)", () => {
    const outcome = planExperiment({
      metricKind: "binomial",
      baselineRate: 0.8,
      armCount: 2,
      fixedSampleSizePerArm: 100,
      power: 0.8,
      alpha: 0.05,
      expectedDailyEligibleEntities: 1_000,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.mdeAbsolute).toBeCloseTo(0.16900047, 5);
    expect(0.8 + outcome.plan.mdeAbsolute).toBeLessThan(1);
    const vars = armVariances({
      metricKind: "binomial",
      baselineVariance: 0.8 * 0.2,
      baselineMean: 0.8,
      mdeAbsolute: outcome.plan.mdeAbsolute,
    });
    const truePower = comparisonPower({
      nControl: 100,
      nTreatment: 100,
      targetN: 200,
      alpha: 0.05,
      varianceControl: vars.control,
      varianceTreatment: vars.treatment,
      effectAbsolute: outcome.plan.mdeAbsolute,
    });
    expect(truePower).toBeCloseTo(0.8, 3);
    expect(outcome.plan.comparisonPowers[0]).toBeCloseTo(truePower, 10);
  });

  it("solves fixed-size binomial MDE jointly with alternative variance", () => {
    const outcome = planExperiment({
      metricKind: "binomial",
      baselineRate: 0.01,
      armCount: 2,
      fixedSampleSizePerArm: 1_000,
      power: 0.8,
      alpha: 0.05,
      expectedDailyEligibleEntities: 1_000,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const vars = armVariances({
      metricKind: "binomial",
      baselineVariance: 0.01 * 0.99,
      baselineMean: 0.01,
      mdeAbsolute: outcome.plan.mdeAbsolute,
    });
    const truePower = comparisonPower({
      nControl: 1_000,
      nTreatment: 1_000,
      targetN: 2_000,
      alpha: 0.05,
      varianceControl: vars.control,
      varianceTreatment: vars.treatment,
      effectAbsolute: outcome.plan.mdeAbsolute,
    });
    expect(outcome.plan.comparisonPowers[0]).toBeCloseTo(truePower, 10);
    expect(truePower).toBeCloseTo(0.8, 3);
    expect(0.01 + outcome.plan.mdeAbsolute).toBeLessThan(1);
  });

  it("refuses tiny fixed-size binomial plans with no feasible admissible MDE", () => {
    // baselineRate 0.8 leaves only ~0.2 of headroom; at n=1 even p1→1 cannot
    // reach 80% power, so the bracketed search correctly reports no solution.
    const outcome = planExperiment({
      metricKind: "binomial",
      baselineRate: 0.8,
      armCount: 2,
      fixedSampleSizePerArm: 1,
      power: 0.8,
      alpha: 0.05,
      expectedDailyEligibleEntities: 1_000,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.path).toEqual(["fixedSampleSizePerArm"]);
  });
});
