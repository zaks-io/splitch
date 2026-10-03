import { describe, expect, it } from "vitest";
import { planExperiment } from "./experiment-plan";
import {
  armVariances,
  comparisonPower,
  comparisonPowersForPlan,
  minComparisonPower,
} from "./experiment-plan-power";

describe("planExperiment binomial guardrail power", () => {
  it("reports power as the minimum across feasible signed breaches", () => {
    // baseline 0.8, modest goal MDE so planned n clears np / n(1-p) under p1;
    // breach 0.1: upward → 0.9, downward → 0.7 (downward has less power).
    const outcome = planExperiment({
      metricKind: "binomial",
      baselineRate: 0.8,
      armCount: 2,
      mdeAbsolute: 0.05,
      guardrailBreachAbsolute: 0.1,
      power: 0.8,
      alpha: 0.05,
      expectedDailyEligibleEntities: 10_000,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const n = outcome.plan.nPerArm[0] as number;
    const upward = comparisonPower({
      nControl: n,
      nTreatment: n,
      targetN: outcome.plan.targetN,
      alpha: 0.05,
      varianceControl: 0.8 * 0.2,
      varianceTreatment: armVariances({
        metricKind: "binomial",
        baselineVariance: 0.8 * 0.2,
        baselineMean: 0.8,
        mdeAbsolute: 0.1,
      }).treatment,
      effectAbsolute: 0.1,
    });
    const downward = comparisonPower({
      nControl: n,
      nTreatment: n,
      targetN: outcome.plan.targetN,
      alpha: 0.05,
      varianceControl: 0.8 * 0.2,
      varianceTreatment: armVariances({
        metricKind: "binomial",
        baselineVariance: 0.8 * 0.2,
        baselineMean: 0.8,
        mdeAbsolute: -0.1,
      }).treatment,
      effectAbsolute: 0.1,
    });
    expect(downward).toBeLessThan(upward);
    expect(outcome.plan.guardrailPower).toBeCloseTo(Math.min(upward, downward), 10);
  });

  it("accepts a downward-only-feasible breach", () => {
    // baseline 0.8, breach 0.3: upward 1.1 outside (0,1); downward 0.5 ok.
    const outcome = planExperiment({
      metricKind: "binomial",
      baselineRate: 0.8,
      armCount: 2,
      mdeAbsolute: 0.05,
      guardrailBreachAbsolute: 0.3,
      power: 0.8,
      alpha: 0.05,
      expectedDailyEligibleEntities: 10_000,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const n = outcome.plan.nPerArm[0] as number;
    const expected = comparisonPower({
      nControl: n,
      nTreatment: n,
      targetN: outcome.plan.targetN,
      alpha: 0.05,
      varianceControl: 0.8 * 0.2,
      varianceTreatment: armVariances({
        metricKind: "binomial",
        baselineVariance: 0.8 * 0.2,
        baselineMean: 0.8,
        mdeAbsolute: -0.3,
      }).treatment,
      effectAbsolute: 0.3,
    });
    expect(outcome.plan.guardrailPower).toBeCloseTo(expected, 10);
  });

  it("sizes under breach-alternative variance, not goal MDE", () => {
    const outcome = planExperiment({
      metricKind: "binomial",
      baselineRate: 0.01,
      armCount: 2,
      mdeAbsolute: 0.01,
      guardrailBreachAbsolute: 0.005,
      power: 0.8,
      alpha: 0.05,
      expectedDailyEligibleEntities: 10_000,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const n = outcome.plan.nPerArm[0] as number;
    const upward = comparisonPower({
      nControl: n,
      nTreatment: n,
      targetN: outcome.plan.targetN,
      alpha: 0.05,
      varianceControl: 0.01 * 0.99,
      varianceTreatment: armVariances({
        metricKind: "binomial",
        baselineVariance: 0.01 * 0.99,
        baselineMean: 0.01,
        mdeAbsolute: 0.005,
      }).treatment,
      effectAbsolute: 0.005,
    });
    const downward = comparisonPower({
      nControl: n,
      nTreatment: n,
      targetN: outcome.plan.targetN,
      alpha: 0.05,
      varianceControl: 0.01 * 0.99,
      varianceTreatment: armVariances({
        metricKind: "binomial",
        baselineVariance: 0.01 * 0.99,
        baselineMean: 0.01,
        mdeAbsolute: -0.005,
      }).treatment,
      effectAbsolute: 0.005,
    });
    expect(outcome.plan.guardrailPower).toBeCloseTo(Math.min(upward, downward), 10);
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
    expect(Math.max(...perComparison)).toBeCloseTo(0.13639, 4);
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

  it("refuses power below the supported z_beta floor", () => {
    const outcome = planExperiment({
      metricKind: "continuous",
      baselineMean: 1,
      baselineVariance: 1,
      armCount: 2,
      fixedSampleSizePerArm: 100,
      power: 0.001,
      expectedDailyEligibleEntities: 1_000,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues).toEqual([
      expect.objectContaining({
        path: ["power"],
        message: expect.stringContaining("[0.5, 1)"),
      }),
    ]);
  });
});
