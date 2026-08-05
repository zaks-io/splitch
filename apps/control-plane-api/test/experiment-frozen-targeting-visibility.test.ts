import {
  CURRENT_KV_SCHEMA_VERSION,
  kvEnvelope,
  RunConfigKVSchema,
  runConfigKey,
} from "@splitch/contracts";
import { envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createExperimentDraft,
  type ExperimentRunHarness,
  experimentFixture,
  makeExperimentRunHarness,
  patchExperiment,
  type StartResponse,
  startExperiment,
} from "../src/experiment-run-test-fixture";
import { request } from "../src/flag-definition-test-harness";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

/**
 * SPL-307: Starting a Run freezes Targeting Rules into the Run. Operators must
 * see that snapshot at Start, on Run read (distinct from the draft), and when
 * staging a draft edit under a live Run — otherwise the silent change in
 * evaluation behavior is invisible.
 */

const RunConfigEnvelope = kvEnvelope(RunConfigKVSchema);

let ctx: ExperimentRunHarness;

beforeEach(async () => {
  ctx = await makeExperimentRunHarness(makeLocalBindings);
});

afterEach(async () => ctx.h.bindings.dispose());

function targetingRule(
  fx: Awaited<ReturnType<typeof experimentFixture>>,
  overrides: { id: string; value?: string },
) {
  return {
    id: overrides.id,
    flagId: fx.flag.id,
    priority: 0,
    conditions: [
      { attribute: "plan", operator: "eq" as const, value: overrides.value ?? "enterprise" },
    ],
    variantId: fx.flag.defaultVariantId,
  };
}

describe("SPL-307 frozen Targeting Rule visibility", () => {
  it("Start response carries frozenTargetingRules matching the RunConfigKV evaluation uses", async () => {
    const fx = await experimentFixture(ctx);
    const rule = targetingRule(fx, { id: "rule_enterprise" });
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "freeze-announce",
      allocation: { control: 50, treatment: 50 },
      salt: "freeze-salt",
      targetingRules: [rule],
    });

    const started = await startExperiment(ctx, fx, experiment.id);
    expect(started.status).toBe(200);
    const body = (await started.json()) as StartResponse & {
      frozenTargetingRules: Array<{ id: string; conditions: unknown[] }>;
    };

    expect(body.frozenTargetingRules).toHaveLength(1);
    expect(body.frozenTargetingRules[0]).toMatchObject({
      id: "rule_enterprise",
      conditions: [{ attribute: "plan", operator: "eq", value: "enterprise" }],
    });
    expect(body.run.targetingRules).toEqual(body.frozenTargetingRules);

    const raw = await ctx.h.bindings.kv.get(
      runConfigKey(fx.appId, fx.environmentId, body.run.id),
      "text",
    );
    expect(raw).toBeTruthy();
    const envelope = RunConfigEnvelope.parse(JSON.parse(raw as string));
    expect(envelope.schemaVersion).toBe(CURRENT_KV_SCHEMA_VERSION);
    expect(envelope.data.targetingRules).toEqual(body.frozenTargetingRules);
  });

  it("Start with an empty draft announces an empty frozen set (all eligible via allocation)", async () => {
    const fx = await experimentFixture(ctx);
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "freeze-empty",
      allocation: { control: 50, treatment: 50 },
      salt: "empty-salt",
    });

    const started = await startExperiment(ctx, fx, experiment.id);
    expect(started.status).toBe(200);
    const body = (await started.json()) as StartResponse & {
      frozenTargetingRules: unknown[];
    };
    expect(body.frozenTargetingRules).toEqual([]);
    expect(body.run.targetingRules).toEqual([]);
  });

  it("a Targeting Rule edit under a live Run succeeds on the draft and states the live Run is unaffected", async () => {
    const fx = await experimentFixture(ctx);
    const frozenRule = targetingRule(fx, { id: "rule_frozen" });
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "stage-unaffected",
      allocation: { control: 50, treatment: 50 },
      salt: "stage-salt",
      targetingRules: [frozenRule],
    });
    const started = await startExperiment(ctx, fx, experiment.id);
    expect(started.status).toBe(200);
    const startBody = (await started.json()) as StartResponse;
    const runId = startBody.run.id;

    const draftRule = targetingRule(fx, { id: "rule_draft_next", value: "team" });
    const patched = await patchExperiment(ctx, fx, experiment.id, {
      stageForNextRun: true,
      targetingRules: [draftRule],
    });
    expect(patched.status).toBe(200);
    const body = (await patched.json()) as {
      draftTargetingRules: Array<{ id: string }>;
      liveRunUnaffected?: { runId: string; frozenTargetingRules: Array<{ id: string }> };
      liveRunId: string | null;
    };

    expect(body.liveRunId).toBe(runId);
    expect(body.draftTargetingRules).toEqual([expect.objectContaining({ id: "rule_draft_next" })]);
    expect(body.liveRunUnaffected).toEqual({
      runId,
      frozenTargetingRules: [expect.objectContaining({ id: "rule_frozen" })],
    });

    // The live Run's frozen snapshot is unchanged.
    const scope = envScope(fx.appId, fx.environmentId);
    const run = await ctx.repo.experiments.getRun(scope, runId);
    expect(JSON.parse(run?.targetingRules ?? "[]")).toEqual([
      expect.objectContaining({ id: "rule_frozen" }),
    ]);
  });

  it("reading the Run exposes frozen rules distinctly from the current draft rules", async () => {
    const fx = await experimentFixture(ctx);
    const frozenRule = targetingRule(fx, { id: "rule_on_run" });
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "read-compare",
      allocation: { control: 50, treatment: 50 },
      salt: "read-salt",
      targetingRules: [frozenRule],
    });
    const started = await startExperiment(ctx, fx, experiment.id);
    const startBody = (await started.json()) as StartResponse;

    const draftRule = targetingRule(fx, { id: "rule_on_draft", value: "starter" });
    expect(
      (
        await patchExperiment(ctx, fx, experiment.id, {
          stageForNextRun: true,
          targetingRules: [draftRule],
        })
      ).status,
    ).toBe(200);

    const got = await request(
      ctx.h,
      "GET",
      `/apps/${fx.appId}/envs/${fx.environmentId}/experiments/${experiment.id}/runs/${startBody.run.id}`,
      fx.jwt,
    );
    expect(got.status).toBe(200);
    const body = (await got.json()) as {
      targetingRules: Array<{ id: string }>;
      draftTargetingRules: Array<{ id: string }> | null;
    };

    expect(body.targetingRules).toEqual([expect.objectContaining({ id: "rule_on_run" })]);
    expect(body.draftTargetingRules).toEqual([expect.objectContaining({ id: "rule_on_draft" })]);
    expect(body.targetingRules).not.toEqual(body.draftTargetingRules);
  });
});
