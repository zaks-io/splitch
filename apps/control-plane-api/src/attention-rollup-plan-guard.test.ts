import { describe, expect, it } from "vitest";
import { assertPlansComplete, type EnvironmentPlan } from "./attention-rollup";

/**
 * Direct unit coverage of the invariant `rollupPlans` enforces before consuming
 * any plan's reads: `reads.length` must equal `runningTotal`.
 *
 * This cannot be exercised end to end through the HTTP handler: the
 * whole-rollup budget check (`runningExperiments > ANALYSIS_READ_LIMIT`) and
 * the per-Environment read bound are set up so that, given today's constants,
 * any single Environment truncated enough to diverge from its own count also
 * pushes the summed total over budget and gets refused first. That is exactly
 * the ordering dependency `assertPlansComplete` exists to not rely on, so it
 * is proven directly, against a fabricated plan a future change (a
 * lowered per-Environment read bound, a relaxed budget check, a second caller
 * of `planEnvironment`) could produce even though nothing today does.
 */
describe("attention rollup plan completeness guard", () => {
  it("refuses a plan whose planned reads are fewer than its own true running-Experiment count", () => {
    const plans: EnvironmentPlan[] = [
      completePlan("env_a", 1),
      { environmentId: "env_b", runningTotal: 90, reads: readsFor("env_b", 50) },
    ];

    expect(() => assertPlansComplete(plans)).toThrow(
      "Environment env_b has 90 running Experiments but only 50 were planned; refusing to silently drop the rest from the rollup",
    );
  });

  it("accepts plans whose read counts match their own true running-Experiment counts", () => {
    const plans: EnvironmentPlan[] = [completePlan("env_a", 3), completePlan("env_b", 0)];

    expect(() => assertPlansComplete(plans)).not.toThrow();
  });
});

function completePlan(environmentId: string, runningTotal: number): EnvironmentPlan {
  return { environmentId, runningTotal, reads: readsFor(environmentId, runningTotal) };
}

function readsFor(environmentId: string, count: number): EnvironmentPlan["reads"] {
  return Array.from({ length: count }, (_, index) => ({
    appId: "app_guard",
    environmentId,
    experimentId: `exp_${environmentId}_${index}`,
    runId: `run_${environmentId}_${index}`,
  }));
}
