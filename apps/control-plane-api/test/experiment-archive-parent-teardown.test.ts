import { appScope, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createExperimentDraft,
  type ExperimentRunHarness,
  experimentFixture,
  makeExperimentRunHarness,
  type StartResponse,
  startExperiment,
} from "../src/experiment-run-test-fixture";
import { allowAllPolicies, errorBody, request } from "../src/flag-definition-test-harness";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

let ctx: ExperimentRunHarness;

beforeEach(async () => {
  ctx = await makeExperimentRunHarness(makeLocalBindings);
});

afterEach(async () => ctx.h.bindings.dispose());

describe("archived Experiment parent teardown and key conflict (SPL-289)", () => {
  it("refuses recreate with an archived Experiment's key", async () => {
    const fx = await experimentFixture(ctx);
    const key = "archived-key-reuse";
    const experiment = await createExperimentDraft(ctx, fx, {
      key,
      allocation: { control: 50, treatment: 50 },
      salt: "archived-key-reuse-salt",
    });
    const del = await request(
      ctx.h,
      "DELETE",
      `/apps/${fx.appId}/envs/${fx.environmentId}/experiments/${experiment.id}`,
      fx.jwt,
    );
    expect(del.status).toBe(200);

    const recreate = await request(
      ctx.h,
      "POST",
      `/apps/${fx.appId}/envs/${fx.environmentId}/experiments`,
      fx.jwt,
      {
        appId: fx.appId,
        environmentId: fx.environmentId,
        name: key,
        key,
        flagId: fx.flag.id,
        targetingKey: "userId",
        targetingKeyType: "user",
        metrics: [{ metricId: fx.metricId }],
        allocation: { control: 50, treatment: 50 },
        salt: "archived-key-reuse-salt-2",
      },
    );
    expect(recreate.status).toBe(409);
    expect(await errorBody(recreate)).toMatchObject({
      code: "EXPERIMENT_KEY_CONFLICT",
      details: {
        key,
        archivedExperimentId: experiment.id,
        recommendedAction: "CHOOSE_DIFFERENT_KEY",
      },
    });
  });

  it("archives then clears Flag and App teardown once only archived Experiments remain", async () => {
    const fx = await experimentFixture(ctx);
    await allowAllPolicies(ctx.h, fx.appId);
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "parent-teardown-after-archive",
      allocation: { control: 50, treatment: 50 },
      salt: "parent-teardown-after-archive-salt",
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

    const archive = await request(
      ctx.h,
      "DELETE",
      `/apps/${fx.appId}/envs/${fx.environmentId}/experiments/${experiment.id}`,
      fx.jwt,
    );
    expect(archive.status).toBe(200);

    const flagDel = await request(
      ctx.h,
      "DELETE",
      `/apps/${fx.appId}/flags/${fx.flag.id}`,
      fx.jwt,
      undefined,
      `idem-flag-${crypto.randomUUID()}`,
    );
    expect(flagDel.status).toBe(200);
    expect(
      await ctx.repo.experiments.peekExperiment(
        envScope(fx.appId, fx.environmentId),
        experiment.id,
      ),
    ).toBeNull();

    expect(
      (await request(ctx.h, "DELETE", `/apps/${fx.appId}/metrics/${fx.metricId}`, fx.jwt)).status,
    ).toBe(200);
    expect(
      (await request(ctx.h, "DELETE", `/apps/${fx.appId}/segments/${fx.segmentId}`, fx.jwt)).status,
    ).toBe(200);

    const envs = await ctx.repo.identity.listEnvironments(appScope(fx.appId));
    const other = envs.find((env) => env.id !== fx.environmentId);
    expect(other).toBeDefined();
    expect(
      (await request(ctx.h, "DELETE", `/apps/${fx.appId}/envs/${other?.id}`, fx.jwt)).status,
    ).toBe(200);
    expect((await request(ctx.h, "DELETE", `/apps/${fx.appId}`, fx.jwt)).status).toBe(200);
  });
});
