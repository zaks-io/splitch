import { envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createExperimentDraft,
  type ExperimentRunHarness,
  experimentFixture,
  makeExperimentRunHarness,
  patchExperiment,
} from "../src/experiment-run-test-fixture";
import { request } from "../src/flag-definition-test-harness";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

let ctx: ExperimentRunHarness;

beforeEach(async () => {
  ctx = await makeExperimentRunHarness(makeLocalBindings);
});

afterEach(async () => ctx.h.bindings.dispose());

describe("Experiment Targeting Rule rollout salts", () => {
  it("mints a salt on create and persists it on the Experiment draft", async () => {
    const fx = await experimentFixture(ctx);
    const res = await request(
      ctx.h,
      "POST",
      `/apps/${fx.appId}/envs/${fx.environmentId}/experiments`,
      fx.jwt,
      {
        appId: fx.appId,
        environmentId: fx.environmentId,
        name: "mint-create",
        key: "mint-create",
        flagId: fx.flag.id,
        targetingKey: "userId",
        targetingKeyType: "user",
        metrics: [{ metricId: fx.metricId }],
        targetingRules: [rule(fx.flag.id, fx.flag.defaultVariantId, { percentage: 25 })],
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      draftTargetingRules: Array<{ percentageRollout?: { percentage: number; salt: string } }>;
    };
    const minted = body.draftTargetingRules[0]?.percentageRollout;
    expect(minted).toEqual({
      percentage: 25,
      salt: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    expect(await storedDraftRollout(fx.appId, fx.environmentId, body.id)).toEqual(minted);
  });

  it("mints a salt on patch and persists it on the Experiment draft", async () => {
    const fx = await experimentFixture(ctx);
    const experiment = await createExperimentDraft(ctx, fx, { key: "mint-patch" });
    const res = await patchExperiment(ctx, fx, experiment.id, {
      targetingRules: [rule(fx.flag.id, fx.flag.defaultVariantId, { percentage: 40 })],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      draftTargetingRules: Array<{ percentageRollout?: { percentage: number; salt: string } }>;
    };
    const minted = body.draftTargetingRules[0]?.percentageRollout;
    expect(minted).toEqual({
      percentage: 40,
      salt: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    expect(await storedDraftRollout(fx.appId, fx.environmentId, body.id)).toEqual(minted);
  });
});

function rule(flagId: string, variantId: string, percentageRollout: { percentage: number }) {
  return {
    id: "rule-rollout",
    flagId,
    priority: 0,
    conditions: [{ attribute: "plan", operator: "eq" as const, value: "paid" }],
    variantId,
    percentageRollout,
  };
}

async function storedDraftRollout(appId: string, environmentId: string, experimentId: string) {
  const row = await ctx.repo.experiments.getExperiment(
    envScope(appId, environmentId),
    experimentId,
  );
  const rules = JSON.parse(row?.draftTargetingRules ?? "[]") as Array<{
    percentageRollout?: { percentage: number; salt: string };
  }>;
  return rules[0]?.percentageRollout;
}
