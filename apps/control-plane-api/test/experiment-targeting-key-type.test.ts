import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createExperimentDraft,
  type ExperimentRunHarness,
  experimentFixture,
  makeExperimentRunHarness,
  patchExperiment,
} from "../src/experiment-run-test-fixture";
import { errorBody, request } from "../src/flag-definition-test-harness";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

/** Mirrors `targetingKeyTypes` in `@splitch/contracts` — keep in sync. */
const targetingKeyTypes = ["user", "session", "workspace"] as const;
const allowedMessage = `allowed targetingKeyType values: ${targetingKeyTypes.join(", ")}`;

let ctx: ExperimentRunHarness;

beforeEach(async () => {
  ctx = await makeExperimentRunHarness(makeLocalBindings);
});

afterEach(async () => ctx.h.bindings.dispose());

describe("control-plane Experiment targetingKeyType vocabulary", () => {
  it("rejects an unrecognized targetingKeyType on create and lists the accepted values", async () => {
    const fx = await experimentFixture(ctx);
    const res = await request(
      ctx.h,
      "POST",
      `/apps/${fx.appId}/envs/${fx.environmentId}/experiments`,
      fx.jwt,
      {
        appId: fx.appId,
        environmentId: fx.environmentId,
        name: "bogus-type",
        key: "bogus-type",
        flagId: fx.flag.id,
        targetingKey: "userId",
        targetingKeyType: "bogus",
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
        message: allowedMessage,
      },
    ]);
  });

  it.each([
    ...targetingKeyTypes,
  ])("accepts recognized targetingKeyType %s on create", async (targetingKeyType) => {
    const fx = await experimentFixture(ctx);
    const experiment = await createExperimentDraft(ctx, fx, {
      key: `type-${targetingKeyType}`,
      targetingKeyType,
    });
    expect(experiment.id).toMatch(/^exp_/);
  });

  it("rejects an unrecognized targetingKeyType on update and lists the accepted values", async () => {
    const fx = await experimentFixture(ctx);
    const experiment = await createExperimentDraft(ctx, fx, { key: "patch-type" });
    const res = await patchExperiment(ctx, fx, experiment.id, { targetingKeyType: "bogus" });
    expect(res.status).toBe(400);
    const err = await errorBody(res);
    expect(err.code).toBe("VALIDATION_ERROR");
    if (err.code !== "VALIDATION_ERROR") return;
    expect(err.details.issues).toEqual([
      {
        path: ["body", "targetingKeyType"],
        message: allowedMessage,
      },
    ]);
  });

  it.each([
    ...targetingKeyTypes,
  ])("accepts recognized targetingKeyType %s on update", async (targetingKeyType) => {
    const fx = await experimentFixture(ctx);
    const experiment = await createExperimentDraft(ctx, fx, {
      key: `patch-ok-${targetingKeyType}`,
    });
    const res = await patchExperiment(ctx, fx, experiment.id, { targetingKeyType });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { targetingKeyType: string };
    expect(body.targetingKeyType).toBe(targetingKeyType);
  });
});
