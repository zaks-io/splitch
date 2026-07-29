import {
  CURRENT_KV_SCHEMA_VERSION,
  deriveMcpTools,
  getRoute,
  liveRunKey,
} from "@splitch/contracts";
import { appScope, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createExperimentDraft,
  type ExperimentRunHarness,
  experimentFixture,
  insertSyntheticNewerRun,
  kvJson,
  makeExperimentRunHarness,
  patchExperiment,
  readEvaluationExperiment,
  readIngestLiveRun,
  type StartResponse,
} from "../src/experiment-run-test-fixture";
import { errorBody, NOW_ISO, request } from "../src/flag-definition-test-harness";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

let ctx: ExperimentRunHarness;

beforeEach(async () => {
  ctx = await makeExperimentRunHarness(makeLocalBindings);
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
    await expect(readEvaluationExperiment(ctx, fx, experiment.id)).resolves.toMatchObject({
      liveRunId: started.run.id,
      liveRun: { id: started.run.id, experimentId: experiment.id },
    });
    await expect(readIngestLiveRun(ctx, fx, experiment.id, "user")).resolves.toEqual({
      ok: true,
      runId: started.run.id,
    });

    const unchangedStart = await request(
      ctx.h,
      "POST",
      `/apps/${fx.appId}/envs/${fx.environmentId}/experiments/${experiment.id}/start`,
      fx.jwt,
    );
    expect(unchangedStart.status).toBe(409);
    expect((await errorBody(unchangedStart)).code).toBe("EXPERIMENT_NO_DRAFT");

    const endFirst = await request(
      ctx.h,
      "POST",
      `/apps/${fx.appId}/envs/${fx.environmentId}/runs/${started.run.id}/end`,
      fx.jwt,
      { reason: "first done" },
    );
    expect(endFirst.status).toBe(200);
    await expect(readEvaluationExperiment(ctx, fx, experiment.id)).resolves.toMatchObject({
      liveRunId: null,
      liveRun: null,
    });
    expect(
      await ctx.h.bindings.kv.get(liveRunKey(fx.appId, fx.environmentId, experiment.id), "text"),
    ).toBe(null);

    expect(
      (
        await patchExperiment(ctx, fx, experiment.id, {
          allocation: { control: 60, treatment: 40 },
          salt: "run-salt-3",
        })
      ).status,
    ).toBe(200);

    const secondStart = await request(
      ctx.h,
      "POST",
      `/apps/${fx.appId}/envs/${fx.environmentId}/experiments/${experiment.id}/start`,
      fx.jwt,
      { reason: "next run" },
    );
    expect(secondStart.status).toBe(200);
    const second = (await secondStart.json()) as StartResponse;
    expect(second.previousRunId).toBeNull();

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
    await expect(readIngestLiveRun(ctx, fx, experiment.id, "user")).resolves.toEqual({
      ok: true,
      runId: second.run.id,
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

describe("control-plane Experiment Run start-time validation", () => {
  it("fails loud on Start when a referenced Segment was deleted (no silent audience widening)", async () => {
    const fx = await experimentFixture(ctx);
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "checkout-exp",
      allocation: { control: 50, treatment: 50 },
      salt: "run-salt-1",
      segmentIds: [fx.segmentId],
    });

    // The Segment vanishes after the draft staged it (raced delete, cleanup, …).
    await ctx.repo.flags.removeSegment(appScope(fx.appId), fx.segmentId);

    const start = await request(
      ctx.h,
      "POST",
      `/apps/${fx.appId}/envs/${fx.environmentId}/experiments/${experiment.id}/start`,
      fx.jwt,
    );

    // Must reject rather than freeze a Run with no Segment rule.
    expect(start.status).toBe(404);
    expect((await errorBody(start)).code).toBe("SEGMENT_NOT_FOUND");
    // No live run was written.
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
