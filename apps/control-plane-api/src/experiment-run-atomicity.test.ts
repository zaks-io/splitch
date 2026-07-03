import { liveRunKey } from "@splitch/contracts";
import { envScope, type EnvScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { errorBody, NOW_ISO } from "./flag-definition-test-harness.js";
import {
  createExperimentDraft,
  endRun,
  experimentFixture,
  type ExperimentRunHarness,
  kvJson,
  makeExperimentRunHarness,
  patchExperiment,
  readEvaluationExperiment,
  readIngestLiveRun,
  startExperiment,
  type StartResponse,
} from "./experiment-run-test-fixture.js";

let ctx: ExperimentRunHarness;

beforeEach(async () => {
  ctx = await makeExperimentRunHarness();
});

afterEach(async () => ctx.h.bindings.dispose());

describe("Experiment Run Start atomicity", () => {
  it("allows only one overlapping Start to consume a draft", async () => {
    const fx = await experimentFixture(ctx);
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "overlapping-start",
      allocation: { control: 50, treatment: 50 },
      salt: "overlapping-salt",
    });

    const starts = await Promise.all([
      startExperiment(ctx, fx, experiment.id),
      startExperiment(ctx, fx, experiment.id),
    ]);
    expect(starts.map((res) => res.status).sort((a, b) => a - b)).toEqual([200, 409]);

    const success = starts.find((res) => res.status === 200);
    const stale = starts.find((res) => res.status === 409);
    expect(success).toBeDefined();
    expect(stale).toBeDefined();
    expect((await errorBody(stale as Response)).code).toBe("EXPERIMENT_NO_DRAFT");
    const started = (await (success as Response).json()) as StartResponse;

    const scope = envScope(fx.appId, fx.environmentId);
    await expectSingleRunningRun(scope, experiment.id, started.run.id);
    expect(await kvJson(ctx, liveRunKey(fx.appId, fx.environmentId, experiment.id))).toMatchObject({
      data: { runId: started.run.id },
    });
    await expect(readEvaluationExperiment(ctx, fx, experiment.id)).resolves.toMatchObject({
      liveRunId: started.run.id,
      liveRun: { id: started.run.id },
    });
    await expect(readIngestLiveRun(ctx, fx, experiment.id, "user")).resolves.toEqual({
      ok: true,
      runId: started.run.id,
    });
  });

  it("rolls back ending the current Run when the replacement Run insert fails", async () => {
    const fx = await experimentFixture(ctx);
    const scope = envScope(fx.appId, fx.environmentId);
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "rollback-start",
      allocation: { control: 50, treatment: 50 },
      salt: "duplicate-salt",
    });

    const first = await startOk(fx, experiment.id);
    expect((await endRun(ctx, fx, first.run.id)).status).toBe(200);
    expect(
      (
        await patchExperiment(ctx, fx, experiment.id, {
          allocation: { control: 60, treatment: 40 },
          salt: "live-salt",
        })
      ).status,
    ).toBe(200);

    const live = await startOk(fx, experiment.id);
    await ctx.repo.experiments.updateExperiment(scope, experiment.id, {
      draftAllocation: JSON.stringify({ control: 50, treatment: 50 }),
      draftSalt: "duplicate-salt",
      draftTargetingRules: null,
      draftSegmentIds: null,
      updatedAt: NOW_ISO,
    });

    const failedStart = await startExperiment(ctx, fx, experiment.id);
    expect(failedStart.status).toBe(500);
    expect((await errorBody(failedStart)).code).toBe("INTERNAL_SERVER_ERROR");

    await expectSingleRunningRun(scope, experiment.id, live.run.id);
    expect((await ctx.repo.experiments.getRun(scope, live.run.id))?.endedAt).toBeNull();
    expect((await ctx.repo.experiments.getRun(scope, first.run.id))?.endedAt).toBe(NOW_ISO);
    expect(await ctx.repo.experiments.getExperiment(scope, experiment.id)).toMatchObject({
      liveRunId: live.run.id,
      draftAllocation: JSON.stringify({ control: 50, treatment: 50 }),
      draftSalt: "duplicate-salt",
    });
    expect(await kvJson(ctx, liveRunKey(fx.appId, fx.environmentId, experiment.id))).toMatchObject({
      data: { runId: live.run.id },
    });
    await expect(readIngestLiveRun(ctx, fx, experiment.id, "user")).resolves.toEqual({
      ok: true,
      runId: live.run.id,
    });
  });
});

describe("Experiment Run End atomicity", () => {
  it("allows only one overlapping End to close a running Run", async () => {
    const fx = await experimentFixture(ctx);
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "overlapping-end",
      allocation: { control: 50, treatment: 50 },
    });
    const started = await startOk(fx, experiment.id);

    const ends = await Promise.all([
      endRun(ctx, fx, started.run.id),
      endRun(ctx, fx, started.run.id),
    ]);
    expect(ends.map((res) => res.status).sort((a, b) => a - b)).toEqual([200, 409]);

    const stale = ends.find((res) => res.status === 409);
    expect(stale).toBeDefined();
    expect((await errorBody(stale as Response)).code).toBe("RUN_NOT_RUNNING");

    const scope = envScope(fx.appId, fx.environmentId);
    expect(await ctx.repo.experiments.getRun(scope, started.run.id)).toMatchObject({
      status: "ended",
      endedAt: NOW_ISO,
    });
    expect(await ctx.repo.experiments.getExperiment(scope, experiment.id)).toMatchObject({
      status: "draft",
      liveRunId: null,
    });
    expect(
      await ctx.h.bindings.kv.get(liveRunKey(fx.appId, fx.environmentId, experiment.id), "text"),
    ).toBe(null);
    await expect(readEvaluationExperiment(ctx, fx, experiment.id)).resolves.toMatchObject({
      liveRunId: null,
      liveRun: null,
    });
  });

  it("rolls back ending the Run when Experiment cleanup fails", async () => {
    const fx = await experimentFixture(ctx);
    const scope = envScope(fx.appId, fx.environmentId);
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "rollback-end",
      allocation: { control: 50, treatment: 50 },
    });
    const started = await startOk(fx, experiment.id);
    await ctx.h.bindings.d1
      .prepare(
        `
        CREATE TRIGGER fail_experiment_end_cleanup
        BEFORE UPDATE OF live_run_id ON experiments
        WHEN NEW.live_run_id IS NULL
        BEGIN
          SELECT RAISE(FAIL, 'forced experiment cleanup failure');
        END
      `,
      )
      .run();

    const failedEnd = await endRun(ctx, fx, started.run.id);
    await ctx.h.bindings.d1.prepare("DROP TRIGGER fail_experiment_end_cleanup").run();
    expect(failedEnd.status).toBe(500);
    expect((await errorBody(failedEnd)).code).toBe("INTERNAL_SERVER_ERROR");

    await expectSingleRunningRun(scope, experiment.id, started.run.id);
    expect(await ctx.repo.experiments.getRun(scope, started.run.id)).toMatchObject({
      status: "running",
      endedAt: null,
    });
    expect(await ctx.repo.experiments.getExperiment(scope, experiment.id)).toMatchObject({
      status: "running",
      liveRunId: started.run.id,
    });
    expect(await kvJson(ctx, liveRunKey(fx.appId, fx.environmentId, experiment.id))).toMatchObject({
      data: { runId: started.run.id },
    });
    await expect(readIngestLiveRun(ctx, fx, experiment.id, "user")).resolves.toEqual({
      ok: true,
      runId: started.run.id,
    });
  });
});

async function startOk(fx: Awaited<ReturnType<typeof experimentFixture>>, experimentId: string) {
  const response = await startExperiment(ctx, fx, experimentId);
  expect(response.status).toBe(200);
  return (await response.json()) as StartResponse;
}

async function expectSingleRunningRun(scope: EnvScope, experimentId: string, runId: string) {
  const rows = await ctx.repo.experiments.listRunsForExperiment(scope, experimentId);
  expect(rows.filter((row) => row.status === "running").map((row) => row.id)).toEqual([runId]);
}
