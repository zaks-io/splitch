import { describe, expect, it } from "vitest";
import { alwaysValidCriticalScale } from "./always-valid-inflation";
import { planExperiment } from "./experiment-plan";
import { monteCarloTolerance } from "./sequential-ci-simulation";
import { SequentialCI } from "./sequential-ci";
import { seededNormal } from "./simulation-null-draws";
import { comparisonEstimate } from "./variance-effects";
import type { MetricArmEstimate } from "./variance-estimator-types";
import { noVarianceTechniques } from "./winsorization";

/**
 * Predeclared seeds and Monte Carlo tolerance for the always-valid inflation
 * planner. Simulations check rejection under the stated MDE at the planner's
 * sizes (not post-hoc power from an observed effect).
 */
const PLANNER_SIM_SEED = "experiment-plan-inflation-4242";
const PLANNER_BINOMIAL_SEED = "experiment-plan-binomial-4242";
const PLANNER_UNEQUAL_SEED = "experiment-plan-unequal-4242";
const PLANNER_SIM_ALPHA = 0.05;
const PLANNER_SIM_POWER = 0.8;
// Regular PR vitest uses a smoke default; `stats:simulation` overrides via env
// (smoke=300, audit=1000). Bernoulli binomial trials are O(n·iters).
const PLANNER_SIM_ITERATIONS = Number.parseInt(
  process.env.SPLITCH_STATS_SIMULATION_ITERATIONS ?? "50",
  10,
);

describe("experiment_plan always-valid inflation simulation", () => {
  it("achieves planned power at the inflated target_n under the stated MDE", () => {
    const mdeAbsolute = 0.15;
    const planned = planExperiment({
      metricKind: "continuous",
      baselineMean: 0,
      baselineVariance: 1,
      armCount: 2,
      mdeAbsolute,
      alpha: PLANNER_SIM_ALPHA,
      power: PLANNER_SIM_POWER,
      expectedDailyEligibleEntities: 10_000,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    const nPerArm = planned.plan.nPerArm[0];
    if (nPerArm === undefined) throw new Error("planned nPerArm missing");
    const rejectionRate = runGaussianPowerTrials({
      seed: PLANNER_SIM_SEED,
      nControl: nPerArm,
      nTreatment: nPerArm,
      targetN: planned.plan.targetN,
      mdeAbsolute,
      varianceControl: 1,
      varianceTreatment: 1,
    });
    const tolerance = monteCarloTolerance(PLANNER_SIM_POWER, PLANNER_SIM_ITERATIONS);
    console.info(
      `experiment_plan inflation seed=${PLANNER_SIM_SEED} iterations=${PLANNER_SIM_ITERATIONS} ` +
        `k*=${planned.plan.alwaysValidInflation} target_n=${planned.plan.targetN} ` +
        `rejectionRate=${rejectionRate} plannedPower=${PLANNER_SIM_POWER} tolerance=${tolerance} ` +
        `criticalScale=${alwaysValidCriticalScale(PLANNER_SIM_ALPHA)}`,
    );
    expect(Math.abs(rejectionRate - PLANNER_SIM_POWER)).toBeLessThanOrEqual(tolerance);
  });

  it("achieves planned power for binomial Metrics under Bernoulli draws", () => {
    const baselineRate = 0.01;
    const mdeAbsolute = 0.01;
    const planned = planExperiment({
      metricKind: "binomial",
      baselineRate,
      armCount: 2,
      mdeAbsolute,
      alpha: PLANNER_SIM_ALPHA,
      power: PLANNER_SIM_POWER,
      expectedDailyEligibleEntities: 10_000,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    const nPerArm = planned.plan.nPerArm[0];
    if (nPerArm === undefined) throw new Error("planned nPerArm missing");
    const rejectionRate = runBernoulliPowerTrials({
      seed: PLANNER_BINOMIAL_SEED,
      nControl: nPerArm,
      nTreatment: nPerArm,
      targetN: planned.plan.targetN,
      baselineRate,
      treatmentRate: baselineRate + mdeAbsolute,
    });
    const tolerance = monteCarloTolerance(PLANNER_SIM_POWER, PLANNER_SIM_ITERATIONS);
    console.info(
      `experiment_plan binomial seed=${PLANNER_BINOMIAL_SEED} iterations=${PLANNER_SIM_ITERATIONS} ` +
        `nPerArm=${nPerArm} target_n=${planned.plan.targetN} rejectionRate=${rejectionRate} ` +
        `plannedPower=${PLANNER_SIM_POWER} tolerance=${tolerance}`,
    );
    expect(Math.abs(rejectionRate - PLANNER_SIM_POWER)).toBeLessThanOrEqual(tolerance);
  });

  it("achieves planned power on every comparison under unequal multi-arm traffic", () => {
    const mdeAbsolute = 0.1;
    const planned = planExperiment({
      metricKind: "continuous",
      baselineMean: 0,
      baselineVariance: 1,
      armCount: 3,
      trafficSplit: [0.1, 0.89, 0.01],
      mdeAbsolute,
      alpha: PLANNER_SIM_ALPHA,
      power: PLANNER_SIM_POWER,
      expectedDailyEligibleEntities: 10_000,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    const nControl = planned.plan.nPerArm[0];
    if (nControl === undefined) throw new Error("planned Control n missing");
    const tolerance = monteCarloTolerance(PLANNER_SIM_POWER, PLANNER_SIM_ITERATIONS);

    for (let arm = 1; arm < planned.plan.nPerArm.length; arm += 1) {
      const nTreatment = planned.plan.nPerArm[arm];
      if (nTreatment === undefined) throw new Error(`planned treatment n missing for arm ${arm}`);
      const rejectionRate = runGaussianPowerTrials({
        seed: `${PLANNER_UNEQUAL_SEED}-arm${arm}`,
        nControl,
        nTreatment,
        targetN: planned.plan.targetN,
        mdeAbsolute,
        varianceControl: 1,
        varianceTreatment: 1,
      });
      console.info(
        `experiment_plan unequal seed=${PLANNER_UNEQUAL_SEED}-arm${arm} iterations=${PLANNER_SIM_ITERATIONS} ` +
          `n_c=${nControl} n_t=${nTreatment} target_n=${planned.plan.targetN} ` +
          `rejectionRate=${rejectionRate} plannedPower=${PLANNER_SIM_POWER} tolerance=${tolerance}`,
      );
      expect(rejectionRate).toBeGreaterThanOrEqual(PLANNER_SIM_POWER - tolerance);
    }
  });
});

function runGaussianPowerTrials(args: {
  seed: string;
  nControl: number;
  nTreatment: number;
  targetN: number;
  mdeAbsolute: number;
  varianceControl: number;
  varianceTreatment: number;
}): number {
  const adapter = new SequentialCI();
  const rng = seededNormal(args.seed);
  let rejections = 0;

  for (let iteration = 0; iteration < PLANNER_SIM_ITERATIONS; iteration += 1) {
    // Draw arm means directly: sum of i.i.d. normals is normal.
    const meanC = rng() * Math.sqrt(args.varianceControl / args.nControl);
    const meanT = rng() * Math.sqrt(args.varianceTreatment / args.nTreatment) + args.mdeAbsolute;
    const result = adapter.compute({
      estimate: meanT - meanC,
      sampling_var: args.varianceControl / args.nControl + args.varianceTreatment / args.nTreatment,
      n_t: args.nTreatment,
      n_c: args.nControl,
      alpha: PLANNER_SIM_ALPHA,
      target_n: args.targetN,
    });
    if (result.status === "ok" && result.p_value <= PLANNER_SIM_ALPHA) {
      rejections += 1;
    }
  }

  return rejections / PLANNER_SIM_ITERATIONS;
}

function runBernoulliPowerTrials(args: {
  seed: string;
  nControl: number;
  nTreatment: number;
  targetN: number;
  baselineRate: number;
  treatmentRate: number;
}): number {
  const adapter = new SequentialCI();
  const uniform = seededUniform(args.seed);
  let rejections = 0;

  for (let iteration = 0; iteration < PLANNER_SIM_ITERATIONS; iteration += 1) {
    const successesC = binomialCount(args.nControl, args.baselineRate, uniform);
    const successesT = binomialCount(args.nTreatment, args.treatmentRate, uniform);
    const control = binomialArmEstimate("control", args.nControl, successesC);
    const treatment = binomialArmEstimate("treatment", args.nTreatment, successesT);
    const comparison = comparisonEstimate(
      {
        run_id: "run_experiment_plan_binomial_sim",
        metric_id: "conversion",
        metric_type: "binomial",
        control_variant: "control",
        treatment_variant: "treatment",
        exposures: [],
        metric_values: [],
      },
      control,
      treatment,
      noVarianceTechniques("binomial"),
    );
    if (comparison.absolute_lift === null || comparison.absolute_lift_sampling_var === null) {
      continue;
    }
    const result = adapter.compute({
      estimate: comparison.absolute_lift,
      // Engine path: estimated per-arm variance with Agresti-Caffo on boundaries.
      sampling_var: comparison.absolute_lift_sampling_var,
      n_t: args.nTreatment,
      n_c: args.nControl,
      alpha: PLANNER_SIM_ALPHA,
      target_n: args.targetN,
    });
    if (result.status === "ok" && result.p_value <= PLANNER_SIM_ALPHA) {
      rejections += 1;
    }
  }

  return rejections / PLANNER_SIM_ITERATIONS;
}

function binomialArmEstimate(variant: string, n: number, successes: number): MetricArmEstimate {
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

/** Exact Binomial(n, p) via Bernoulli trials (n is a few thousand in these gates). */
function binomialCount(n: number, p: number, uniform: () => number): number {
  let successes = 0;
  for (let index = 0; index < n; index += 1) {
    if (uniform() < p) successes += 1;
  }
  return successes;
}

function seededUniform(seed: string): () => number {
  // Same FNV-1a + mulberry32 path as seededNormal, exposed as U(0,1) for Bernoulli.
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  let state = hash >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let next = state;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}
