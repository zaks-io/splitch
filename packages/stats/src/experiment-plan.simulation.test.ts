import { describe, expect, it } from "vitest";
import { alwaysValidCriticalScale } from "./always-valid-inflation";
import { planExperiment } from "./experiment-plan";
import { monteCarloTolerance } from "./sequential-ci-simulation";
import { SequentialCI } from "./sequential-ci";
import { seededNormal } from "./simulation-null-draws";

/**
 * Predeclared seeds and Monte Carlo tolerance for the always-valid inflation
 * planner. The simulation checks that at the planner's target_n, under an
 * absolute-lift MDE, the engine's mixture rejects at approximately the planned
 * power (not post-hoc power from an observed effect).
 */
const PLANNER_SIM_SEED = "experiment-plan-inflation-4242";
const PLANNER_SIM_ALPHA = 0.05;
const PLANNER_SIM_POWER = 0.8;
const PLANNER_SIM_ITERATIONS = Number.parseInt(
  process.env.SPLITCH_STATS_SIMULATION_ITERATIONS ?? "400",
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
    const rejectionRate = runPowerTrials({
      nPerArm,
      targetN: planned.plan.targetN,
      mdeAbsolute,
      baselineVariance: 1,
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
});

function runPowerTrials(args: {
  nPerArm: number;
  targetN: number;
  mdeAbsolute: number;
  baselineVariance: number;
}): number {
  const adapter = new SequentialCI();
  const rng = seededNormal(PLANNER_SIM_SEED);
  let rejections = 0;

  for (let iteration = 0; iteration < PLANNER_SIM_ITERATIONS; iteration += 1) {
    // Per-Entity outcomes ~ N(0, 1) in Control and N(mde, 1) in Treatment.
    let sumT = 0;
    let sumC = 0;
    for (let index = 0; index < args.nPerArm; index += 1) {
      sumC += rng();
      sumT += rng() + args.mdeAbsolute;
    }
    const result = adapter.compute({
      estimate: sumT / args.nPerArm - sumC / args.nPerArm,
      sampling_var: (2 * args.baselineVariance) / args.nPerArm,
      n_t: args.nPerArm,
      n_c: args.nPerArm,
      alpha: PLANNER_SIM_ALPHA,
      target_n: args.targetN,
    });
    if (result.status === "ok" && result.p_value <= PLANNER_SIM_ALPHA) {
      rejections += 1;
    }
  }

  return rejections / PLANNER_SIM_ITERATIONS;
}
