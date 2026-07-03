import { liveRunKey } from "@splitch/contracts";
import { envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { errorBody, NOW_ISO, request } from "./flag-definition-test-harness.js";
import {
  createExperimentDraft,
  endRun,
  experimentFixture,
  type ExperimentRunHarness,
  makeExperimentRunHarness,
  type StartResponse,
  startExperiment,
} from "./experiment-run-test-fixture.js";

let ctx: ExperimentRunHarness;

beforeEach(async () => {
  ctx = await makeExperimentRunHarness();
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

    const confirmed = await request(
      ctx.h,
      "POST",
      `/apps/${fx.appId}/envs/${fx.environmentId}/experiments/${experiment.id}/start`,
      fx.jwt,
      { confirm: true },
    );
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
