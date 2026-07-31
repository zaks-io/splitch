import { describe, expect, it } from "vitest";
import {
  type AttentionRollupDeps,
  assertPlansComplete,
  type EnvironmentPlan,
  planEnvironment,
} from "./attention-rollup";
import {
  ATTENTION_TEST_TIMEOUT,
  QA_ENVIRONMENT_ID,
  repository,
  setupAttentionRollupFixture,
} from "./attention-rollup-fixture";
import { seedRunningExperiments } from "./attention-rollup-seeds";
import { ids } from "./config-store-fixture-data";

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

/**
 * Companion to the fixture-based tests above: those prove the guard fires
 * against a hand-set `EnvironmentPlan`, which says nothing about whether real
 * `planEnvironment` output can ever actually diverge like that. This calls
 * the real function against a real seeded D1, past its own read bound, so
 * `reads.length` (the bounded read's own page size) and `runningTotal` (from
 * the real COUNT) are both genuine, not asserted into existence. Calling
 * `planEnvironment` directly, instead of through the HTTP handler, is
 * deliberate: it is the only way to reach this divergence at all, since the
 * whole-rollup budget check in `rollupResponse` refuses first given today's
 * constants (see the module doc above).
 */
describe("attention rollup plan completeness guard against real planEnvironment output", () => {
  setupAttentionRollupFixture();

  it("refuses a real plan whose bounded read and COUNT genuinely diverge", {
    timeout: ATTENTION_TEST_TIMEOUT,
  }, async () => {
    const repo = repository();
    await seedRunningExperiments(repo, QA_ENVIRONMENT_ID, 210);
    const deps: AttentionRollupDeps = {
      repo,
      analysisResults: { read: () => Promise.reject(new Error("unused")) },
    };

    const plan = await planEnvironment(deps, ids.appId, QA_ENVIRONMENT_ID);

    expect(plan.reads).toHaveLength(201);
    expect(plan.runningTotal).toBe(210);
    expect(() => assertPlansComplete([plan])).toThrow(
      `Environment ${QA_ENVIRONMENT_ID} has 210 running Experiments but only 201 were planned; refusing to silently drop the rest from the rollup`,
    );
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
