import { describe, expect, it } from "vitest";
import { planExperiment } from "./experiment-plan";
import { armVariances, comparisonPower } from "./experiment-plan-size";

describe("planExperiment binomial and bound regressions", () => {
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

  it("refuses tiny fixed-size binomial plans that imply an impossible alternative rate", () => {
    const outcome = planExperiment({
      metricKind: "binomial",
      baselineRate: 0.01,
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

  it("sizes guardrail power under breach-alternative variance, not goal MDE", () => {
    const outcome = planExperiment({
      metricKind: "binomial",
      baselineRate: 0.8,
      armCount: 2,
      mdeAbsolute: 0.19,
      guardrailBreachAbsolute: 0.1,
      power: 0.8,
      alpha: 0.05,
      expectedDailyEligibleEntities: 10_000,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const n = outcome.plan.nPerArm[0] as number;
    const breachVars = armVariances({
      metricKind: "binomial",
      baselineVariance: 0.8 * 0.2,
      baselineMean: 0.8,
      mdeAbsolute: 0.1,
    });
    const expected = comparisonPower({
      nControl: n,
      nTreatment: n,
      targetN: outcome.plan.targetN,
      alpha: 0.05,
      varianceControl: breachVars.control,
      varianceTreatment: breachVars.treatment,
      effectAbsolute: 0.1,
    });
    expect(outcome.plan.guardrailPower).toBeCloseTo(expected, 10);
    // Goal-MDE variance would overstate power (~16% vs ~9% here).
    expect(outcome.plan.guardrailPower).toBeLessThan(0.12);
  });

  it("refuses unrepresentable oversized plans instead of hanging", () => {
    const outcome = planExperiment({
      metricKind: "continuous",
      baselineMean: 0,
      baselineVariance: 1,
      armCount: 2,
      mdeAbsolute: 1e-9,
      power: 0.8,
      alpha: 0.05,
      expectedDailyEligibleEntities: 1e12,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.path).toEqual(["mdeAbsolute"]);
    expect(outcome.issues[0]?.message).toContain("maximum");
  });
});
