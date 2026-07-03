import {
  CURRENT_KV_SCHEMA_VERSION,
  deriveMcpTools,
  getRoute,
  liveRunKey,
} from "@splitch/contracts";
import { envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NOW_ISO, request } from "./flag-definition-test-harness.js";
import {
  createExperimentDraft,
  experimentFixture,
  type ExperimentRunHarness,
  insertSyntheticNewerRun,
  kvJson,
  makeExperimentRunHarness,
  patchExperiment,
  type StartResponse,
} from "./experiment-run-test-fixture.js";

let ctx: ExperimentRunHarness;

beforeEach(async () => {
  ctx = await makeExperimentRunHarness();
});

afterEach(async () => ctx.h.bindings.dispose());

describe("control-plane Experiment Run lifecycle", () => {
  it("round-trips draft -> Start -> End and writes explicit live_run KV", async () => {
    const fx = await experimentFixture(ctx);
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "checkout-exp",
      allocation: { control: 50, treatment: 50 },
      salt: "run-salt-1",
      segmentIds: [fx.segmentId],
    });

    expect((await patchExperiment(ctx, fx, experiment.id, { salt: "run-salt-2" })).status).toBe(
      200,
    );
    expect(
      (
        await patchExperiment(ctx, fx, experiment.id, {
          allocation: { control: 40, treatment: 60 },
        })
      ).status,
    ).toBe(200);

    const start = await request(
      ctx.h,
      "POST",
      `/apps/${fx.appId}/envs/${fx.environmentId}/experiments/${experiment.id}/start`,
      fx.jwt,
    );
    expect(start.status).toBe(200);
    const started = (await start.json()) as StartResponse;
    expect(started.previousRunId).toBeNull();
    expect(started.run.runNumber).toBeUndefined();
    expect(started.run.allocation).toEqual({ control: 40, treatment: 60 });
    expect(started.run.targetingRules[0]?.conditions).toEqual([
      { attribute: "plan", operator: "eq", value: "paid" },
    ]);

    const rows = await ctx.repo.experiments.listRunsForExperiment(
      envScope(fx.appId, fx.environmentId),
      experiment.id,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.runNumber).toBe(1);

    const liveRunEnvelope = await kvJson(
      ctx,
      liveRunKey(fx.appId, fx.environmentId, experiment.id),
    );
    expect(liveRunEnvelope).toMatchObject({
      schemaVersion: CURRENT_KV_SCHEMA_VERSION,
      data: { runId: started.run.id },
    });

    const secondStart = await request(
      ctx.h,
      "POST",
      `/apps/${fx.appId}/envs/${fx.environmentId}/experiments/${experiment.id}/start`,
      fx.jwt,
      { reason: "next run" },
    );
    expect(secondStart.status).toBe(200);
    const second = (await secondStart.json()) as StartResponse;
    expect(second.previousRunId).toBe(started.run.id);

    const afterSecondStart = await ctx.repo.experiments.listRunsForExperiment(
      envScope(fx.appId, fx.environmentId),
      experiment.id,
    );
    expect(afterSecondStart.map((row) => row.runNumber).sort((a, b) => a - b)).toEqual([1, 2]);

    const prior = await ctx.repo.experiments.getRun(
      envScope(fx.appId, fx.environmentId),
      started.run.id,
    );
    expect(prior?.endedAt).toBe(NOW_ISO);

    await insertSyntheticNewerRun(ctx, fx, experiment.id);
    expect(await kvJson(ctx, liveRunKey(fx.appId, fx.environmentId, experiment.id))).toMatchObject({
      data: { runId: second.run.id },
    });

    const end = await request(
      ctx.h,
      "POST",
      `/apps/${fx.appId}/envs/${fx.environmentId}/runs/${second.run.id}/end`,
      fx.jwt,
      { reason: "done" },
    );
    expect(end.status).toBe(200);
    expect((await end.json()) as { status: string; endedAt: string }).toMatchObject({
      status: "ended",
      endedAt: NOW_ISO,
    });
    expect(
      await ctx.h.bindings.kv.get(liveRunKey(fx.appId, fx.environmentId, experiment.id), "text"),
    ).toBe(null);
  });
});

describe("Experiment Run MCP derivation", () => {
  it("derives experiments_start and runs_end from the shared routes", () => {
    const tools = deriveMcpTools();
    for (const operationId of ["experiments_start", "runs_end"] as const) {
      const route = getRoute(operationId);
      const tool = tools.find((candidate) => candidate.name === operationId);
      expect(route).toBeDefined();
      expect(tool).toBeDefined();
      expect(tool?.outputSchema).toBe(route?.output);
    }
  });
});
