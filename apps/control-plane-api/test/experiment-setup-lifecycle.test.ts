import { appScope, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createExperimentDraft,
  type ExperimentRunHarness,
  experimentFixture,
  makeExperimentRunHarness,
  patchExperiment,
  startExperiment,
  type StartResponse,
} from "../src/experiment-run-test-fixture";
import { errorBody, NOW_ISO, request } from "../src/flag-definition-test-harness";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

let ctx: ExperimentRunHarness;

beforeEach(async () => {
  ctx = await makeExperimentRunHarness(makeLocalBindings);
});

afterEach(async () => ctx.h.bindings.dispose());

describe("control-plane Experiment Setup edit taxonomy", () => {
  it("keeps safe edits on the current Run and opens the next Run only through explicit staging", async () => {
    const fx = await experimentFixture(ctx);
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "setup-taxonomy",
      allocation: { control: 50, treatment: 50 },
      salt: "setup-run-1",
      segmentIds: [fx.segmentId],
    });
    await ctx.repo.identity.updateEnvironment(appScope(fx.appId), fx.environmentId, {
      policy: JSON.stringify({
        variantAvailability: "allow",
        targetingRolloutValue: "allow",
        enabledState: "allow",
        startExperimentRun: "allow",
      }),
    });
    const firstStart = await startExperiment(ctx, fx, experiment.id);
    const first = (await firstStart.json()) as StartResponse;

    const forcedAssignmentEdit = await patchExperiment(ctx, fx, experiment.id, {
      allocation: { control: 60, treatment: 40 },
    });
    expect(forcedAssignmentEdit.status).toBe(409);
    await expect(errorBody(forcedAssignmentEdit)).resolves.toMatchObject({
      code: "RUN_FROZEN",
      details: { currentRunId: first.run.id, recommendedAction: "CREATE_NEW_RUN" },
    });

    const measurementEdit = await patchExperiment(ctx, fx, experiment.id, {
      conversionWindowMs: 172_800_000,
      description: "Checkout conversion",
      owner: "growth",
      tags: ["checkout", "q3"],
    });
    expect(measurementEdit.status).toBe(200);
    expect(
      await ctx.repo.experiments.listRunsForExperiment(
        envScope(fx.appId, fx.environmentId),
        experiment.id,
      ),
    ).toHaveLength(1);

    const staged = await patchExperiment(ctx, fx, experiment.id, {
      stageForNextRun: true,
      allocation: { control: 60, treatment: 40 },
    });
    expect(staged.status).toBe(200);
    const stagedRow = await ctx.repo.experiments.getExperiment(
      envScope(fx.appId, fx.environmentId),
      experiment.id,
    );
    expect(stagedRow).toMatchObject({
      liveRunId: first.run.id,
      draftAllocation: JSON.stringify({ control: 60, treatment: 40 }),
      draftSalt: null,
    });
    expect(JSON.parse(stagedRow?.draftTargetingRules ?? "[]")).toHaveLength(1);

    await ctx.repo.identity.updateEnvironment(appScope(fx.appId), fx.environmentId, {
      policy: JSON.stringify({
        variantAvailability: "allow",
        targetingRolloutValue: "allow",
        enabledState: "allow",
        startExperimentRun: "confirm",
      }),
    });
    const gated = await request(
      ctx.h,
      "POST",
      `/apps/${fx.appId}/envs/${fx.environmentId}/experiments/${experiment.id}/start`,
      fx.jwt,
      { idempotency_key: "idem_setup_gate" },
    );
    // A `confirm` policy no longer bounces the Start with a bare flag; it opens an
    // Approval Request and names it, so the operator confirms a specific pending
    // proposal rather than re-sending the same call with a confirmation bit set.
    expect(gated.status).toBe(409);
    expect((await errorBody(gated)).code).toBe("APPROVAL_REVIEW_REQUIRED");

    const secondStart = await startExperiment(ctx, fx, experiment.id, {
      idempotency_key: "idem_setup_run_2",
      review: { action: "approve_and_apply" },
      reason: "Increase treatment traffic",
    });
    expect(secondStart.status).toBe(200);
    const second = (await secondStart.json()) as StartResponse;
    expect(second.previousRunId).toBe(first.run.id);
    expect(second.run.allocation).toEqual({ control: 60, treatment: 40 });

    const runs = await ctx.repo.experiments.listRunsForExperiment(
      envScope(fx.appId, fx.environmentId),
      experiment.id,
    );
    expect(runs).toHaveLength(2);
    expect(runs.find((run) => run.id === first.run.id)).toMatchObject({
      status: "ended",
      endedAt: NOW_ISO,
    });
    expect(runs.find((run) => run.id === second.run.id)).toMatchObject({
      status: "running",
      startReason: "Increase treatment traffic",
    });
  });
});
