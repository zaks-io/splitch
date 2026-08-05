import { appScope } from "@splitch/db";
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
import { errorBody, request } from "../src/flag-definition-test-harness";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

const SHAPE_MESSAGE = "must be lowercase alphanumerics separated by single underscores";

let ctx: ExperimentRunHarness;

beforeEach(async () => {
  ctx = await makeExperimentRunHarness(makeLocalBindings);
});

afterEach(async () => ctx.h.bindings.dispose());

async function allowStart(fx: Awaited<ReturnType<typeof experimentFixture>>) {
  await ctx.repo.identity.updateEnvironment(appScope(fx.appId), fx.environmentId, {
    policy: JSON.stringify({
      variantAvailability: "allow",
      targetingRolloutValue: "allow",
      enabledState: "allow",
      startExperimentRun: "allow",
    }),
  });
}

describe("control-plane Experiment targetingKeyType shape", () => {
  it("rejects a typo-shaped targetingKeyType on create and names the shape rule", async () => {
    const fx = await experimentFixture(ctx);
    const res = await request(
      ctx.h,
      "POST",
      `/apps/${fx.appId}/envs/${fx.environmentId}/experiments`,
      fx.jwt,
      {
        appId: fx.appId,
        environmentId: fx.environmentId,
        name: "typo-type",
        key: "typo-type",
        flagId: fx.flag.id,
        targetingKey: "userId",
        targetingKeyType: "User",
        metrics: [{ metricId: fx.metricId }],
      },
    );
    expect(res.status).toBe(400);
    const err = await errorBody(res);
    expect(err.code).toBe("VALIDATION_ERROR");
    if (err.code !== "VALIDATION_ERROR") return;
    expect(err.details.issues).toEqual([
      {
        path: ["body", "targetingKeyType"],
        message: SHAPE_MESSAGE,
      },
    ]);
  });

  it("accepts a non-blessed Entity type on create", async () => {
    const fx = await experimentFixture(ctx);
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "type-restaurant",
      targetingKeyType: "restaurant",
    });
    expect(experiment.id).toMatch(/^exp_/);
  });

  it("rejects a typo-shaped targetingKeyType on update and names the shape rule", async () => {
    const fx = await experimentFixture(ctx);
    const experiment = await createExperimentDraft(ctx, fx, { key: "patch-typo" });
    const res = await patchExperiment(ctx, fx, experiment.id, { targetingKeyType: "user-type" });
    expect(res.status).toBe(400);
    const err = await errorBody(res);
    expect(err.code).toBe("VALIDATION_ERROR");
    if (err.code !== "VALIDATION_ERROR") return;
    expect(err.details.issues).toEqual([
      {
        path: ["body", "targetingKeyType"],
        message: SHAPE_MESSAGE,
      },
    ]);
  });

  it("accepts a non-blessed Entity type on update", async () => {
    const fx = await experimentFixture(ctx);
    const experiment = await createExperimentDraft(ctx, fx, { key: "patch-account" });
    const res = await patchExperiment(ctx, fx, experiment.id, { targetingKeyType: "account" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { targetingKeyType: string };
    expect(body.targetingKeyType).toBe("account");
  });

  it("still Starts an Experiment stored with a legal non-blessed Entity type", async () => {
    const fx = await experimentFixture(ctx);
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "account-start",
      targetingKeyType: "account",
      allocation: { control: 50, treatment: 50 },
      salt: "account-start-salt",
    });
    await allowStart(fx);

    // Echo the stored type through a draft patch the way the Control Panel does
    // on Start (read-then-resend). A closed enum would make this permanently
    // un-startable; shape validation must keep the value echoable.
    const staged = await patchExperiment(ctx, fx, experiment.id, {
      stageForNextRun: true,
      targetingKeyType: "account",
      allocation: { control: 50, treatment: 50 },
    });
    expect(staged.status).toBe(200);

    const started = await startExperiment(ctx, fx, experiment.id);
    expect(started.status).toBe(200);
    const body = (await started.json()) as StartResponse;
    expect(body.run.targetingKeyType).toBe("account");
  });
});
