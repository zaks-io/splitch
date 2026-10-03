import { describe, expect, it } from "vitest";
import { planExperiment } from "./experiment-plan";
import { armVariances, comparisonPower } from "./experiment-plan-power";
import { SequentialCI } from "./sequential-ci";
import { comparisonEstimate } from "./variance-effects";
import type { MetricArmEstimate } from "./variance-estimator-types";
import { noVarianceTechniques } from "./winsorization";

describe("planExperiment binomial MDE regressions", () => {
  it("solves fixed-size binomial MDE when an intermediate estimate exits (0, 1)", () => {
    // n must clear the binomial asymptotic floor under both rates (np and n(1-p) ≥ 10).
    // At baseline 0.8 the solved MDE ≈ 0.055 keeps treatment failures above that floor.
    const outcome = planExperiment({
      metricKind: "binomial",
      baselineRate: 0.8,
      armCount: 2,
      fixedSampleSizePerArm: 1_000,
      power: 0.8,
      alpha: 0.05,
      expectedDailyEligibleEntities: 1_000,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.mdeAbsolute).toBeCloseTo(0.064535, 5);
    expect(0.8 + outcome.plan.mdeAbsolute).toBeLessThan(1);
    const vars = armVariances({
      metricKind: "binomial",
      baselineVariance: 0.8 * 0.2,
      baselineMean: 0.8,
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

describe("planExperiment asymptotic sample-size guard", () => {
  it("refuses a derived binomial plan whose theoretical power is outside the asymptotic regime", () => {
    // Theoretical sizing claims n=[2,2] at ~100% power; estimated-variance SequentialCI
    // rejects none of the nine (successes_c, successes_t) pairs at that size.
    const outcome = planExperiment({
      metricKind: "binomial",
      baselineRate: 0.001,
      armCount: 2,
      mdeAbsolute: 0.998,
      alpha: 0.01,
      power: 0.8,
      expectedDailyEligibleEntities: 1_000,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.path).toEqual(["mdeAbsolute"]);
    expect(outcome.issues[0]?.message).toContain("asymptotic regime");
    expect(rejectionCountAtTinyBinomialN()).toBe(0);
  });

  it("refuses a fixed-size continuous plan whose skinny arm is below the per-arm floor", () => {
    const outcome = planExperiment({
      metricKind: "continuous",
      baselineMean: 1,
      baselineVariance: 1,
      armCount: 2,
      trafficSplit: [0.999, 0.001],
      fixedSampleSizePerArm: 100,
      expectedDailyEligibleEntities: 100,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.path).toEqual(["fixedSampleSizePerArm"]);
    expect(outcome.issues[0]?.message).toContain("asymptotic regime");
  });
});

describe("planExperiment duration under unequal traffic", () => {
  it("sizes duration from the slowest arm after unequal-split rounding", () => {
    // Control 10000 / share 0.999 and treatment ceil(10000*0.001/0.999)=11 clear the
    // per-arm floor; ceil on the skinny arm makes treatment the binding calendar day.
    const outcome = planExperiment({
      metricKind: "continuous",
      baselineMean: 1,
      baselineVariance: 1,
      armCount: 2,
      trafficSplit: [0.999, 0.001],
      fixedSampleSizePerArm: 10_000,
      expectedDailyEligibleEntities: 100,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.nPerArm).toEqual([10_000, 11]);
    // Total-entities formula would give ceil(10011/100)=101; treatment needs 110 days.
    expect(outcome.plan.expectedDurationDays).toBe(110);
  });
});

/** Exhaustive SequentialCI rejections over the 3×3 success grid at n=2 per arm. */
function rejectionCountAtTinyBinomialN(): number {
  const adapter = new SequentialCI();
  let rejections = 0;
  for (let successesC = 0; successesC <= 2; successesC += 1) {
    for (let successesT = 0; successesT <= 2; successesT += 1) {
      if (rejectsTinyBinomialLook(adapter, successesC, successesT)) {
        rejections += 1;
      }
    }
  }
  return rejections;
}

function rejectsTinyBinomialLook(
  adapter: SequentialCI,
  successesC: number,
  successesT: number,
): boolean {
  const comparison = comparisonEstimate(
    {
      run_id: "run_asymptotic_guard",
      metric_id: "conversion",
      metric_type: "binomial",
      control_variant: "control",
      treatment_variant: "treatment",
      exposures: [],
      metric_values: [],
    },
    binomialArm("control", 2, successesC),
    binomialArm("treatment", 2, successesT),
    noVarianceTechniques("binomial"),
  );
  if (comparison.absolute_lift === null || comparison.absolute_lift_sampling_var === null) {
    return false;
  }
  const result = adapter.compute({
    estimate: comparison.absolute_lift,
    sampling_var: comparison.absolute_lift_sampling_var,
    n_t: 2,
    n_c: 2,
    alpha: 0.01,
    target_n: 4,
  });
  return result.status === "ok" && result.p_value <= 0.01;
}

function binomialArm(variant: string, n: number, successes: number): MetricArmEstimate {
  const rate = successes / n;
  const armVariance = rate * (1 - rate);
  return {
    variant,
    metric_id: "conversion",
    metric_type: "binomial",
    sample_size_n: n,
    point_estimate: rate,
    sampling_var: armVariance / n,
    status: "ready",
    arm_variance: armVariance,
    denominator_mean: null,
    zero_denominator_entity_count: 0,
    delta_method: false,
    variance_techniques: noVarianceTechniques("binomial"),
  };
}
