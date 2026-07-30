import { appScope, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createExperimentDraft,
  type ExperimentRunHarness,
  experimentFixture,
  type Fixture,
  makeExperimentRunHarness,
  patchExperiment,
  startExperiment,
  type StartResponse,
} from "../src/experiment-run-test-fixture";
import { errorBody } from "../src/flag-definition-test-harness";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

/**
 * The reverse race of the one CodeRabbit reported.
 *
 * PATCH decides which fields it may write from a read of the Experiment. On a
 * `draft` Experiment that read says "no Run is running", so the identity fields
 * (`targetingKey`, `targetingKeyType`, `flagId`, `activationMetricId`) are
 * writable. If a Run Starts before the write lands, those fields go onto a row
 * the new Run's published ExperimentConfig is already serving — re-bucketing a
 * live sample, which ADR-0014 forbids outright.
 *
 * Every test here Starts the Run from inside `beforeExperimentUpdate`, i.e.
 * strictly after the guard read and strictly before the write. Without that
 * control the interleaving never happens and the test proves nothing.
 */

let ctx: ExperimentRunHarness;
let interleaved: (() => Promise<void>) | null = null;

beforeEach(async () => {
  interleaved = null;
  ctx = await makeExperimentRunHarness(makeLocalBindings, {
    beforeExperimentUpdate: async () => {
      // Fires once. The retry has to see the post-Start world, not a third one.
      const pending = interleaved;
      interleaved = null;
      await pending?.();
    },
  });
});

afterEach(async () => ctx.h.bindings.dispose());

async function draftExperiment(key: string) {
  const fx = await experimentFixture(ctx);
  const experiment = await createExperimentDraft(ctx, fx, {
    key,
    allocation: { control: 50, treatment: 50 },
    salt: "run-1-salt",
  });
  await ctx.repo.identity.updateEnvironment(appScope(fx.appId), fx.environmentId, {
    policy: JSON.stringify({
      variantAvailability: "allow",
      targetingRolloutValue: "allow",
      enabledState: "allow",
      startExperimentRun: "allow",
    }),
  });
  return { fx, experimentId: experiment.id };
}

function liveRow(fx: Fixture, experimentId: string) {
  return ctx.repo.experiments.getExperiment(envScope(fx.appId, fx.environmentId), experimentId);
}

/** Arms the Start that lands between the next PATCH's guard read and its write. */
function startBetweenGuardAndWrite(fx: Fixture, experimentId: string): { runId: string | null } {
  const started: { runId: string | null } = { runId: null };
  interleaved = async () => {
    const response = await startExperiment(ctx, fx, experimentId);
    expect(response.status, "interleaved Start must succeed").toBe(200);
    started.runId = ((await response.json()) as StartResponse).run.id;
  };
  return started;
}

describe("PATCH racing a concurrent Start", () => {
  it("does not rewrite assignment identity when a Run Starts mid-PATCH (stageForNextRun: true)", async () => {
    const { fx, experimentId } = await draftExperiment("race-staged");
    const started = startBetweenGuardAndWrite(fx, experimentId);

    const response = await patchExperiment(ctx, fx, experimentId, {
      stageForNextRun: true,
      targetingKey: "orgId",
    });

    // The Start happened, so the replayed decision is the one a running
    // Experiment gets: these fields have no draft column and cannot be staged.
    expect(started.runId).not.toBeNull();
    expect(response.status).toBe(409);
    expect(await errorBody(response)).toMatchObject({
      code: "RUN_FROZEN",
      details: {
        frozenFields: ["experiment.targetingKey"],
        currentRunId: started.runId,
        attemptedChange: "PATCH_EXPERIMENT_STAGE_FOR_NEXT_RUN",
      },
    });

    expect(await liveRow(fx, experimentId)).toMatchObject({
      targetingKeyField: "userId",
      liveRunId: started.runId,
    });
    const run = await ctx.repo.experiments.getRun(
      envScope(fx.appId, fx.environmentId),
      started.runId ?? "",
    );
    expect(run?.targetingKeyField).toBe("userId");
  });

  it("does not rewrite assignment identity when a Run Starts mid-PATCH (no stageForNextRun)", async () => {
    const { fx, experimentId } = await draftExperiment("race-unstaged");
    const started = startBetweenGuardAndWrite(fx, experimentId);

    const response = await patchExperiment(ctx, fx, experimentId, { targetingKey: "orgId" });

    expect(started.runId).not.toBeNull();
    expect(response.status).toBe(409);
    expect(await errorBody(response)).toMatchObject({
      code: "RUN_FROZEN",
      details: {
        frozenFields: ["experiment.targetingKey"],
        currentRunId: started.runId,
        attemptedChange: "PATCH_EXPERIMENT",
      },
    });

    expect(await liveRow(fx, experimentId)).toMatchObject({ targetingKeyField: "userId" });
  });

  it("still rejects an unstageable field the caller could not have known was frozen", async () => {
    const { fx, experimentId } = await draftExperiment("race-key-type");
    const started = startBetweenGuardAndWrite(fx, experimentId);

    const response = await patchExperiment(ctx, fx, experimentId, {
      stageForNextRun: true,
      targetingKeyType: "workspace",
    });

    expect(started.runId).not.toBeNull();
    expect(response.status).toBe(409);
    expect(await liveRow(fx, experimentId)).toMatchObject({ targetingKeyType: "user" });
  });

  /**
   * The compare-and-set must not turn every concurrent Start into a 409: a
   * non-assignment edit is legal against a running Run, so replaying it has to
   * land. This is also what proves the interleave is real rather than a no-op —
   * the Run exists by the time the PATCH returns 200.
   */
  it("replays and applies an edit that is legal under the new Run", async () => {
    const { fx, experimentId } = await draftExperiment("race-benign");
    const started = startBetweenGuardAndWrite(fx, experimentId);

    const response = await patchExperiment(ctx, fx, experimentId, {
      description: "renamed while a Run was starting",
    });

    expect(started.runId).not.toBeNull();
    expect(response.status).toBe(200);
    expect(await liveRow(fx, experimentId)).toMatchObject({
      description: "renamed while a Run was starting",
      status: "running",
      liveRunId: started.runId,
      targetingKeyField: "userId",
    });
  });

  /**
   * Staging IS legal under a running Run, so the replayed write must land on the
   * draft columns — and must land against the Run that now exists, not the
   * absent one the first attempt read.
   */
  it("replays a staged allocation edit onto the draft columns", async () => {
    const { fx, experimentId } = await draftExperiment("race-stage-allocation");
    const started = startBetweenGuardAndWrite(fx, experimentId);

    const response = await patchExperiment(ctx, fx, experimentId, {
      stageForNextRun: true,
      allocation: { control: 10, treatment: 90 },
    });

    expect(started.runId).not.toBeNull();
    expect(response.status).toBe(200);
    expect(await liveRow(fx, experimentId)).toMatchObject({
      draftAllocation: JSON.stringify({ control: 10, treatment: 90 }),
      liveRunId: started.runId,
    });
  });
});
