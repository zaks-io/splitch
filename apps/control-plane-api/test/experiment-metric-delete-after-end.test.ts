import { appScope, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createExperimentDraft,
  type ExperimentRunHarness,
  experimentFixture,
  makeExperimentRunHarness,
  startExperiment,
  type StartResponse,
} from "../src/experiment-run-test-fixture";
import { errorBody, request } from "../src/flag-definition-test-harness";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

let ctx: ExperimentRunHarness;
let beforeRemove: (() => Promise<void>) | null = null;

beforeEach(async () => {
  beforeRemove = null;
  ctx = await makeExperimentRunHarness(makeLocalBindings, {
    beforeRemoveExperiment: async () => {
      const pending = beforeRemove;
      beforeRemove = null;
      await pending?.();
    },
  });
});

afterEach(async () => ctx.h.bindings.dispose());

describe("experiment and metric delete after Run end (SPL-289)", () => {
  it("deletes an Experiment (and its ended D1 Runs) after End, never 500s", async () => {
    const fx = await experimentFixture(ctx);
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "delete-after-end",
      allocation: { control: 50, treatment: 50 },
      salt: "delete-after-end-salt",
    });
    const start = await startExperiment(ctx, fx, experiment.id);
    expect(start.status).toBe(200);
    const started = (await start.json()) as StartResponse;

    const end = await request(
      ctx.h,
      "POST",
      `/apps/${fx.appId}/envs/${fx.environmentId}/runs/${started.run.id}/end`,
      fx.jwt,
    );
    expect(end.status).toBe(200);

    const scope = envScope(fx.appId, fx.environmentId);
    expect(await ctx.repo.experiments.getExperiment(scope, experiment.id)).toMatchObject({
      status: "draft",
      liveRunId: null,
    });
    expect(await ctx.repo.experiments.listRunsForExperiment(scope, experiment.id)).toHaveLength(1);

    const del = await request(
      ctx.h,
      "DELETE",
      `/apps/${fx.appId}/envs/${fx.environmentId}/experiments/${experiment.id}`,
      fx.jwt,
    );
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ deleted: true });
    expect(await ctx.repo.experiments.getExperiment(scope, experiment.id)).toBeNull();
    expect(await ctx.repo.experiments.listRunsForExperiment(scope, experiment.id)).toEqual([]);
  });

  it("refuses Experiment delete while a Run is still running", async () => {
    const fx = await experimentFixture(ctx);
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "delete-while-running",
      allocation: { control: 50, treatment: 50 },
      salt: "delete-while-running-salt",
    });
    const start = await startExperiment(ctx, fx, experiment.id);
    expect(start.status).toBe(200);
    const started = (await start.json()) as StartResponse;

    const del = await request(
      ctx.h,
      "DELETE",
      `/apps/${fx.appId}/envs/${fx.environmentId}/experiments/${experiment.id}`,
      fx.jwt,
    );
    expect(del.status).toBe(409);
    expect(await errorBody(del)).toMatchObject({
      code: "EXPERIMENT_RUNNING",
      details: {
        experimentId: experiment.id,
        runningRunId: started.run.id,
        attemptedOp: "DELETE_EXPERIMENT",
      },
    });
    expect(
      await ctx.repo.experiments.getExperiment(envScope(fx.appId, fx.environmentId), experiment.id),
    ).not.toBeNull();
  });

  it("fails closed when a Run Starts between the delete guard and the cascade write", async () => {
    const fx = await experimentFixture(ctx);
    await ctx.repo.identity.updateEnvironment(appScope(fx.appId), fx.environmentId, {
      policy: JSON.stringify({
        variantAvailability: "allow",
        targetingRolloutValue: "allow",
        enabledState: "allow",
        startExperimentRun: "allow",
      }),
    });
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "delete-vs-start-race",
      allocation: { control: 50, treatment: 50 },
      salt: "delete-vs-start-race-salt",
    });
    let startedRunId: string | null = null;
    beforeRemove = async () => {
      const response = await startExperiment(ctx, fx, experiment.id);
      expect(response.status, "interleaved Start must succeed").toBe(200);
      startedRunId = ((await response.json()) as StartResponse).run.id;
    };

    const del = await request(
      ctx.h,
      "DELETE",
      `/apps/${fx.appId}/envs/${fx.environmentId}/experiments/${experiment.id}`,
      fx.jwt,
    );
    expect(del.status).toBe(409);
    expect(await errorBody(del)).toMatchObject({
      code: "EXPERIMENT_RUNNING",
      details: {
        experimentId: experiment.id,
        runningRunId: startedRunId,
        attemptedOp: "DELETE_EXPERIMENT",
      },
    });
    const scope = envScope(fx.appId, fx.environmentId);
    expect(await ctx.repo.experiments.getExperiment(scope, experiment.id)).toMatchObject({
      status: "running",
      liveRunId: startedRunId,
    });
    expect(await ctx.repo.experiments.listRunsForExperiment(scope, experiment.id)).toHaveLength(1);
  });

  it("allows Metric delete after End, and still blocks while a Run is running", async () => {
    const fx = await experimentFixture(ctx);
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "metric-delete-guard",
      allocation: { control: 50, treatment: 50 },
      salt: "metric-delete-guard-salt",
    });
    const start = await startExperiment(ctx, fx, experiment.id);
    expect(start.status).toBe(200);
    const started = (await start.json()) as StartResponse;

    const whileRunning = await request(
      ctx.h,
      "DELETE",
      `/apps/${fx.appId}/metrics/${fx.metricId}`,
      fx.jwt,
    );
    expect(whileRunning.status).toBe(409);
    expect(await errorBody(whileRunning)).toMatchObject({
      code: "EXPERIMENT_RUNNING",
      details: {
        experimentId: experiment.id,
        runningRunId: started.run.id,
        attemptedOp: "DELETE_METRIC",
      },
    });

    const end = await request(
      ctx.h,
      "POST",
      `/apps/${fx.appId}/envs/${fx.environmentId}/runs/${started.run.id}/end`,
      fx.jwt,
    );
    expect(end.status).toBe(200);

    const afterEnd = await request(
      ctx.h,
      "DELETE",
      `/apps/${fx.appId}/metrics/${fx.metricId}`,
      fx.jwt,
    );
    expect(afterEnd.status).toBe(200);
    expect(await afterEnd.json()).toEqual({ deleted: true });
    expect(await ctx.repo.experiments.getMetric(appScope(fx.appId), fx.metricId)).toBeNull();
  });
});
