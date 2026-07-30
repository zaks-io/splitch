import { flagConfigKey, liveRunKey } from "@splitch/contracts";
import { envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createExperimentDraft,
  type ExperimentRunHarness,
  endRun,
  experimentFixture,
  kvJson,
  makeExperimentRunHarness,
  readEvaluationExperiment,
  type StartResponse,
  startExperiment,
} from "../src/experiment-run-test-fixture";
import { errorBody, NOW_ISO, request } from "../src/flag-definition-test-harness";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

let ctx: ExperimentRunHarness;

beforeEach(async () => {
  ctx = await makeExperimentRunHarness(makeLocalBindings);
});

afterEach(async () => ctx.h.bindings.dispose());

describe("control-plane Experiment Run invariants", () => {
  it("returns ALLOCATION_INVALID, VARIANT_NOT_AVAILABLE, RUN_NOT_RUNNING, and RUN_FROZEN", async () => {
    const fx = await experimentFixture(ctx);
    const badAllocation = await createExperimentDraft(ctx, fx, {
      key: "bad-allocation",
      allocation: { control: 50, treatment: 40 },
    });
    const allocationStart = await startExperiment(ctx, fx, badAllocation.id);
    expect(allocationStart.status).toBe(400);
    expect((await errorBody(allocationStart)).code).toBe("ALLOCATION_INVALID");

    await ctx.repo.flags.updateFlagConfig(envScope(fx.appId, fx.environmentId), fx.flag.id, {
      availableVariantNames: JSON.stringify(["control"]),
      updatedAt: NOW_ISO,
    });
    const unavailable = await createExperimentDraft(ctx, fx, {
      key: "unavailable",
      allocation: { control: 50, treatment: 50 },
    });
    const unavailableStart = await startExperiment(ctx, fx, unavailable.id);
    expect(unavailableStart.status).toBe(409);
    expect((await errorBody(unavailableStart)).code).toBe("VARIANT_NOT_AVAILABLE");

    await ctx.repo.flags.updateFlagConfig(envScope(fx.appId, fx.environmentId), fx.flag.id, {
      availableVariantNames: JSON.stringify(["control", "treatment"]),
      updatedAt: NOW_ISO,
    });
    const running = await createExperimentDraft(ctx, fx, {
      key: "running",
      allocation: { control: 50, treatment: 50 },
    });
    const started = (await (await startExperiment(ctx, fx, running.id)).json()) as StartResponse;
    const frozenPatch = await request(
      ctx.h,
      "PATCH",
      `/apps/${fx.appId}/envs/${fx.environmentId}/experiments/${running.id}`,
      fx.jwt,
      { allocation: { control: 100 } },
    );
    expect(frozenPatch.status).toBe(409);
    expect((await errorBody(frozenPatch)).code).toBe("RUN_FROZEN");

    const statusPatch = await request(
      ctx.h,
      "PATCH",
      `/apps/${fx.appId}/envs/${fx.environmentId}/experiments/${running.id}`,
      fx.jwt,
      { status: "ended" },
    );
    expect(statusPatch.status).toBe(400);
    expect((await errorBody(statusPatch)).code).toBe("VALIDATION_ERROR");

    const firstEnd = await endRun(ctx, fx, started.run.id);
    expect(firstEnd.status).toBe(200);
    const secondEnd = await endRun(ctx, fx, started.run.id);
    expect(secondEnd.status).toBe(409);
    expect((await errorBody(secondEnd)).code).toBe("RUN_NOT_RUNNING");
  });

  it("checks Policy confirmation before state change and freezes Segment rules", async () => {
    const fx = await experimentFixture(ctx, "prod");
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "policy-gated",
      allocation: { control: 50, treatment: 50 },
      segmentIds: [fx.segmentId],
    });

    const gated = await startExperiment(ctx, fx, experiment.id);
    expect(gated.status).toBe(409);
    expect((await errorBody(gated)).code).toBe("CONFIRMATION_REQUIRED");
    expect(
      await ctx.repo.experiments.listRunsForExperiment(
        envScope(fx.appId, fx.environmentId),
        experiment.id,
      ),
    ).toEqual([]);
    expect(
      await ctx.h.bindings.kv.get(liveRunKey(fx.appId, fx.environmentId, experiment.id), "text"),
    ).toBe(null);

    const legacyConfirm = await startExperiment(ctx, fx, experiment.id, { confirm: true });
    expect(legacyConfirm.status).toBe(400);
    expect((await errorBody(legacyConfirm)).code).toBe("VALIDATION_ERROR");

    const confirmed = await startExperiment(ctx, fx, experiment.id, {
      review: { action: "approve_and_apply" },
    });
    expect(confirmed.status).toBe(200);
    const started = (await confirmed.json()) as StartResponse;

    const segmentPatch = await request(
      ctx.h,
      "PATCH",
      `/apps/${fx.appId}/segments/${fx.segmentId}`,
      fx.jwt,
      {
        name: "Enterprise plan",
        conditions: [{ attribute: "plan", operator: "eq", value: "enterprise" }],
      },
    );
    expect(segmentPatch.status).toBe(200);

    const getRun = await request(
      ctx.h,
      "GET",
      `/apps/${fx.appId}/envs/${fx.environmentId}/experiments/${experiment.id}/runs/${started.run.id}`,
      fx.jwt,
    );
    expect(getRun.status).toBe(200);
    expect(
      (await getRun.json()) as { targetingRules: Array<{ conditions: unknown[] }> },
    ).toMatchObject({
      targetingRules: [{ conditions: [{ attribute: "plan", operator: "eq", value: "paid" }] }],
    });
  });
});

describe("same-Flag Experiment Start guard", () => {
  it("rejects Start when another running Experiment controls the same Flag", async () => {
    const fx = await experimentFixture(ctx);
    const experimentA = await createExperimentDraft(ctx, fx, {
      key: "same-flag-a",
      allocation: { control: 50, treatment: 50 },
      salt: "same-flag-a-salt",
    });
    const startA = await startExperiment(ctx, fx, experimentA.id);
    expect(startA.status).toBe(200);
    const startedA = (await startA.json()) as StartResponse;

    const experimentB = await createExperimentDraft(ctx, fx, {
      key: "same-flag-b",
      allocation: { control: 50, treatment: 50 },
      salt: "same-flag-b-salt",
    });

    const rejected = await startExperiment(ctx, fx, experimentB.id);
    expect(rejected.status).toBe(409);
    expect(await errorBody(rejected)).toMatchObject({
      code: "EXPERIMENT_RUNNING",
      details: {
        experimentId: experimentA.id,
        runningRunId: startedA.run.id,
        attemptedOp: "START_EXPERIMENT_RUN",
        recommendedAction: "END_RUNNING_RUN_FIRST",
      },
    });

    const scope = envScope(fx.appId, fx.environmentId);
    expect(await ctx.repo.experiments.getExperiment(scope, experimentB.id)).toMatchObject({
      status: "draft",
      liveRunId: null,
    });
    expect(await ctx.repo.experiments.listRunsForExperiment(scope, experimentB.id)).toEqual([]);
    expect(await kvJson(ctx, flagConfigKey(fx.appId, fx.environmentId, fx.flag.key))).toMatchObject(
      {
        data: { id: fx.flag.id, experimentId: experimentA.id },
      },
    );
    await expect(readEvaluationExperiment(ctx, fx, experimentA.id)).resolves.toMatchObject({
      liveRunId: startedA.run.id,
      liveRun: { id: startedA.run.id },
    });
  });
});
