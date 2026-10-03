import { describe, expect, it } from "vitest";
import { planExperiment } from "./experiment-plan";
import {
  armVariances,
  comparisonPower,
  comparisonPowersForPlan,
  minComparisonPower,
} from "./experiment-plan-power";

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
});

describe("planExperiment bound and unequal-traffic regressions", () => {
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

  it("reports unequal-traffic guardrail power as the minimum across comparisons", () => {
    const outcome = planExperiment({
      metricKind: "continuous",
      baselineMean: 0,
      baselineVariance: 1,
      armCount: 3,
      trafficSplit: [0.0001, 0.0001, 0.9998],
      mdeAbsolute: 0.1,
      guardrailBreachAbsolute: 0.05,
      power: 0.8,
      alpha: 0.05,
      expectedDailyEligibleEntities: 1e9,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const perComparison = comparisonPowersForPlan({
      nPerArm: outcome.plan.nPerArm,
      targetN: outcome.plan.targetN,
      alpha: 0.05,
      varianceControl: 1,
      varianceTreatment: 1,
      effectAbsolute: 0.05,
    });
    const expectedMin = Math.min(...perComparison);
    expect(outcome.plan.guardrailPower).toBeCloseTo(expectedMin, 10);
    expect(outcome.plan.guardrailPower).toBeCloseTo(0.09096, 4);
    // Smallest-arm-only would overstate worst-case power under shared targetN.
    expect(Math.max(...perComparison)).toBeCloseTo(0.13639, 4);
    expect(expectedMin).toBeLessThan(Math.max(...perComparison));

    // Goal-metric path already sizes/reports every comparison; min must bind.
    expect(Math.min(...outcome.plan.comparisonPowers)).toBeGreaterThanOrEqual(0.8);
    expect(
      minComparisonPower({
        nPerArm: outcome.plan.nPerArm,
        targetN: outcome.plan.targetN,
        alpha: 0.05,
        varianceControl: 1,
        varianceTreatment: 1,
        effectAbsolute: 0.1,
      }),
    ).toBeCloseTo(Math.min(...outcome.plan.comparisonPowers), 10);
  });

  it("refuses fixed-size plans whose derived arm counts exceed safe integers", () => {
    const outcome = planExperiment({
      metricKind: "continuous",
      baselineMean: 0,
      baselineVariance: 1,
      armCount: 2,
      trafficSplit: [1e-16, 1],
      fixedSampleSizePerArm: 100,
      expectedDailyEligibleEntities: 1_000,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.path).toEqual(["fixedSampleSizePerArm"]);
    expect(outcome.issues[0]?.message).toContain("representable maximum");
  });

  it("refuses plans whose expectedDurationDays is not a safe integer", () => {
    const outcome = planExperiment({
      metricKind: "continuous",
      baselineMean: 1,
      baselineVariance: 1,
      armCount: 2,
      mdeAbsolute: 0.1,
      expectedDailyEligibleEntities: 1e-20,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.some((issue) => issue.path[0] === "expectedDurationDays")).toBe(true);
  });

  it("refuses plans whose mdeRelative overflows to non-finite", () => {
    const outcome = planExperiment({
      metricKind: "continuous",
      baselineMean: 1e-320,
      baselineVariance: 1,
      armCount: 2,
      mdeAbsolute: 0.1,
      expectedDailyEligibleEntities: 1_000,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues).toEqual([
      expect.objectContaining({
        path: ["mdeRelative"],
        message: expect.stringContaining("finite and positive"),
      }),
    ]);
  });

  it("refuses alpha below the supported inverse-normal floor", () => {
    const outcome = planExperiment({
      metricKind: "continuous",
      baselineMean: 1,
      baselineVariance: 1,
      armCount: 2,
      mdeAbsolute: 0.1,
      alpha: 1e-20,
      expectedDailyEligibleEntities: 1_000,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.path).toEqual(["alpha"]);
  });
});
