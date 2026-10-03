import { describe, expect, it } from "vitest";
import { alwaysValidCriticalScale, alwaysValidInflation } from "./always-valid-inflation";
import { planExperiment } from "./experiment-plan";
import { inverseNormalCdf } from "./normal-distribution";
import { normalMixtureScale, rhoSquaredForTargetN } from "./sequential-ci";

describe("alwaysValidInflation", () => {
  it("matches Schultzberg k* = (u_alpha / z_{alpha/2})^2 for the engine mixture", () => {
    const alpha = 0.05;
    const targetN = 5_000;
    const scale = normalMixtureScale(targetN, alpha, rhoSquaredForTargetN(alpha, targetN));
    const zCritical = -inverseNormalCdf(alpha / 2);
    expect(alwaysValidInflation(alpha)).toBeCloseTo((scale / zCritical) ** 2, 12);
    expect(alwaysValidCriticalScale(alpha)).toBeCloseTo(scale, 12);
  });

  it("is independent of the chosen target_n at the tuned decision time", () => {
    const alpha = 0.05;
    const scaleSmall = normalMixtureScale(100, alpha, rhoSquaredForTargetN(alpha, 100));
    const scaleLarge = normalMixtureScale(10_000, alpha, rhoSquaredForTargetN(alpha, 10_000));
    expect(scaleSmall).toBeCloseTo(scaleLarge, 12);
  });

  it("computes k* for tiny alpha via the lower-tail critical (no inverseNormalCdf throw)", () => {
    expect(() => alwaysValidInflation(1e-20)).not.toThrow();
    expect(alwaysValidInflation(1e-20)).toBeGreaterThan(1);
  });
});

describe("planExperiment validation", () => {
  it("refuses a continuous Metric with no baseline mean or variance", () => {
    const outcome = planExperiment({
      metricKind: "continuous",
      armCount: 2,
      mdeAbsolute: 0.1,
      expectedDailyEligibleEntities: 1_000,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.map((issue) => issue.path.join("."))).toEqual([
      "baselineMean",
      "baselineVariance",
    ]);
  });

  it("refuses a binomial Metric with no baseline rate", () => {
    const outcome = planExperiment({
      metricKind: "binomial",
      armCount: 2,
      mdeAbsolute: 0.02,
      expectedDailyEligibleEntities: 500,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues).toEqual([
      { path: ["baselineRate"], message: "baselineRate is required for binomial Metrics." },
    ]);
  });

  it("refuses a binomial alternative rate outside (0, 1)", () => {
    const outcome = planExperiment({
      metricKind: "binomial",
      baselineRate: 0.95,
      armCount: 2,
      mdeAbsolute: 0.1,
      expectedDailyEligibleEntities: 1_000,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues).toEqual([
      {
        path: ["mdeAbsolute"],
        message: "Alternative treatment rate (baselineRate + MDE) must be in (0, 1).",
      },
    ]);
  });

  it("refuses relative MDE on a zero baseline", () => {
    const outcome = planExperiment({
      metricKind: "continuous",
      baselineMean: 0,
      baselineVariance: 1,
      armCount: 2,
      mdeRelative: 0.1,
      expectedDailyEligibleEntities: 1_000,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues).toEqual([
      {
        path: ["mdeAbsolute"],
        message: "mdeRelative requires a non-zero baseline; provide mdeAbsolute instead.",
      },
    ]);
  });

  it("refuses relative guardrail breach on a zero baseline", () => {
    const outcome = planExperiment({
      metricKind: "continuous",
      baselineMean: 0,
      baselineVariance: 1,
      armCount: 2,
      mdeAbsolute: 0.1,
      guardrailBreachRelative: 0.05,
      expectedDailyEligibleEntities: 1_000,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues).toEqual([
      {
        path: ["guardrailBreachAbsolute"],
        message:
          "guardrailBreachRelative requires a non-zero baseline; provide guardrailBreachAbsolute instead.",
      },
    ]);
  });

  it("rejects observed-effect-shaped input that omits both MDE and fixed size", () => {
    const outcome = planExperiment({
      metricKind: "continuous",
      baselineMean: 1,
      baselineVariance: 1,
      armCount: 2,
      expectedDailyEligibleEntities: 100,
    });
    expect(outcome.ok).toBe(false);
  });
});

describe("planExperiment sizing", () => {
  it("plans size from absolute MDE and returns a Start-ready targetN", () => {
    const outcome = planExperiment({
      metricKind: "continuous",
      baselineMean: 10,
      baselineVariance: 25,
      armCount: 2,
      mdeAbsolute: 0.5,
      alpha: 0.05,
      power: 0.8,
      expectedDailyEligibleEntities: 2_000,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.mode).toBe("size_from_mde");
    expect(outcome.plan.baselineSource).toBe("caller");
    expect(outcome.plan.alwaysValidInflation).toBeGreaterThan(1);
    expect(outcome.plan.targetN).toBe(
      (outcome.plan.nPerArm[0] ?? 0) + (outcome.plan.nPerArm[1] ?? 0),
    );
    expect(outcome.plan.nPerArm[0]).toBeGreaterThanOrEqual(outcome.plan.fixedHorizonNPerArm);
    expect(outcome.plan.expectedDurationDays).toBeGreaterThan(0);
    expect(outcome.plan.mdeRelative).toBeCloseTo(0.05, 10);
    expect(outcome.plan.guardrailPower).toBeNull();
  });

  it("plans size from relative MDE for a binomial Metric", () => {
    const outcome = planExperiment({
      metricKind: "binomial",
      baselineRate: 0.1,
      armCount: 2,
      mdeRelative: 0.1,
      expectedDailyEligibleEntities: 1_000,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.mdeAbsolute).toBeCloseTo(0.01, 12);
    expect(outcome.plan.baselineVariance).toBeCloseTo(0.09, 12);
    expect(outcome.plan.comparisonPowers).toHaveLength(1);
    expect(outcome.plan.comparisonPowers[0]).toBeGreaterThanOrEqual(0.8);
  });

  it("sizes binomial Metrics under alternative-rate variance p0(1-p0)+p1(1-p1)", () => {
    const outcome = planExperiment({
      metricKind: "binomial",
      baselineRate: 0.01,
      armCount: 2,
      mdeAbsolute: 0.01,
      power: 0.8,
      alpha: 0.05,
      expectedDailyEligibleEntities: 10_000,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Baseline-only variance undersizes (~2976); alternative-rate variance is larger.
    expect(outcome.plan.nPerArm[0]).toBeGreaterThan(4_000);
    expect(outcome.plan.comparisonPowers[0]).toBeGreaterThanOrEqual(0.8);
  });

  it("sizes unequal multi-arm so every comparison reaches requested power", () => {
    const outcome = planExperiment({
      metricKind: "continuous",
      baselineMean: 0,
      baselineVariance: 1,
      armCount: 3,
      trafficSplit: [0.1, 0.89, 0.01],
      mdeAbsolute: 0.1,
      power: 0.8,
      alpha: 0.05,
      expectedDailyEligibleEntities: 10_000,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.comparisonPowers).toHaveLength(2);
    for (const achieved of outcome.plan.comparisonPowers) {
      expect(achieved).toBeGreaterThanOrEqual(0.8);
    }
    // Binding skinny arm forces a larger Control than Control+primary-only sizing.
    expect(outcome.plan.targetN).toBeGreaterThan(163_677);
  });

  it("solves MDE from a fixed per-arm sample size", () => {
    const outcome = planExperiment({
      metricKind: "continuous",
      baselineMean: 1,
      baselineVariance: 1,
      armCount: 2,
      fixedSampleSizePerArm: 5_000,
      expectedDailyEligibleEntities: 1_000,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.mode).toBe("mde_from_size");
    expect(outcome.plan.nPerArm).toEqual([5_000, 5_000]);
    expect(outcome.plan.targetN).toBe(10_000);
    expect(outcome.plan.mdeAbsolute).toBeGreaterThan(0);
  });

  it("reports guardrail power for a stated breach size", () => {
    const outcome = planExperiment({
      metricKind: "continuous",
      baselineMean: 10,
      baselineVariance: 25,
      armCount: 2,
      mdeAbsolute: 0.5,
      guardrailBreachAbsolute: 0.5,
      expectedDailyEligibleEntities: 2_000,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.guardrailPower).not.toBeNull();
    const guardrailPower = outcome.plan.guardrailPower;
    if (guardrailPower === null) return;
    expect(guardrailPower).toBeGreaterThan(0.5);
    expect(guardrailPower).toBeLessThanOrEqual(1);
  });
});
