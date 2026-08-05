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
  endRun,
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

async function assertFrozenMatchesEvaluation(
  fx: Awaited<ReturnType<typeof experimentFixture>>,
  body: StartResponse & { frozenTargetingRules: unknown[] },
) {
  expect(body.frozenTargetingRules.length).toBeGreaterThan(0);
  expect(body.run.targetingRules).toEqual(body.frozenTargetingRules);
  const raw = await ctx.h.bindings.kv.get(
    runConfigKey(fx.appId, fx.environmentId, body.run.id),
    "text",
  );
  expect(raw).toBeTruthy();
  const envelope = RunConfigEnvelope.parse(JSON.parse(raw as string));
  expect(envelope.schemaVersion).toBe(CURRENT_KV_SCHEMA_VERSION);
  expect(envelope.data.targetingRules).toEqual(body.frozenTargetingRules);
}

describe("SPL-307 Start frozen Targeting Rule announcement", () => {
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
    await assertFrozenMatchesEvaluation(fx, body);
  });

  it("approval-gated Start reports frozenTargetingRules matching Run and RunConfigKV", async () => {
    const fx = await experimentFixture(ctx, "prod");
    const rule = targetingRule(fx, { id: "rule_confirm_freeze" });
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "freeze-confirm",
      allocation: { control: 50, treatment: 50 },
      salt: "confirm-salt",
      targetingRules: [rule],
    });

    const started = await startExperiment(ctx, fx, experiment.id, {
      review: { action: "approve_and_apply" },
    });
    expect(started.status).toBe(200);
    const body = (await started.json()) as StartResponse & {
      frozenTargetingRules: Array<{ id: string }>;
      approvalRequest: { status: string } | null;
    };
    expect(body.approvalRequest).toMatchObject({ status: "applied" });
    expect(body.frozenTargetingRules).toEqual([
      expect.objectContaining({ id: "rule_confirm_freeze" }),
    ]);
    await assertFrozenMatchesEvaluation(fx, body);

    const replay = await startExperiment(ctx, fx, experiment.id, {
      review: { action: "approve_and_apply" },
    });
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as StartResponse & {
      frozenTargetingRules: unknown[];
    };
    expect(replayBody.frozenTargetingRules).toEqual(body.frozenTargetingRules);
    expect(replayBody.run.targetingRules).toEqual(body.frozenTargetingRules);
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
});

describe("SPL-307 liveRunUnaffected notice", () => {
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

    const scope = envScope(fx.appId, fx.environmentId);
    const run = await ctx.repo.experiments.getRun(scope, runId);
    expect(JSON.parse(run?.targetingRules ?? "[]")).toEqual([
      expect.objectContaining({ id: "rule_frozen" }),
    ]);
  });

  it("omits liveRunUnaffected when Targeting Rules are staged with no live Run", async () => {
    const fx = await experimentFixture(ctx);
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "stage-no-live",
      allocation: { control: 50, treatment: 50 },
      salt: "no-live-salt",
      targetingRules: [targetingRule(fx, { id: "rule_draft_only" })],
    });

    const patched = await patchExperiment(ctx, fx, experiment.id, {
      stageForNextRun: true,
      targetingRules: [targetingRule(fx, { id: "rule_next", value: "team" })],
    });
    expect(patched.status).toBe(200);
    const body = (await patched.json()) as {
      liveRunId: string | null;
      liveRunUnaffected?: unknown;
      draftTargetingRules: Array<{ id: string }>;
    };
    expect(body.liveRunId).toBeNull();
    expect(body.liveRunUnaffected).toBeUndefined();
    expect(body.draftTargetingRules).toEqual([expect.objectContaining({ id: "rule_next" })]);
  });

  it("omits liveRunUnaffected for a non-assignment staged field under a live Run", async () => {
    const fx = await experimentFixture(ctx);
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "stage-name-only",
      allocation: { control: 50, treatment: 50 },
      salt: "name-salt",
      targetingRules: [targetingRule(fx, { id: "rule_live" })],
    });
    const started = await startExperiment(ctx, fx, experiment.id);
    expect(started.status).toBe(200);

    const patched = await patchExperiment(ctx, fx, experiment.id, {
      stageForNextRun: true,
      name: "Renamed while live",
    });
    expect(patched.status).toBe(200);
    const body = (await patched.json()) as {
      name: string;
      liveRunUnaffected?: unknown;
    };
    expect(body.name).toBe("Renamed while live");
    expect(body.liveRunUnaffected).toBeUndefined();
  });
});

describe("SPL-307 Run GET frozen vs draft", () => {
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

  it("Run GET still returns draft Targeting Rules after the Experiment is archived", async () => {
    const fx = await experimentFixture(ctx);
    const frozenRule = targetingRule(fx, { id: "rule_archived_frozen" });
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "read-archived",
      allocation: { control: 50, treatment: 50 },
      salt: "archived-salt",
      targetingRules: [frozenRule],
    });
    const started = await startExperiment(ctx, fx, experiment.id);
    const startBody = (await started.json()) as StartResponse;
    expect((await endRun(ctx, fx, startBody.run.id)).status).toBe(200);

    const draftRule = targetingRule(fx, { id: "rule_archived_draft", value: "team" });
    expect(
      (
        await patchExperiment(ctx, fx, experiment.id, {
          stageForNextRun: true,
          targetingRules: [draftRule],
        })
      ).status,
    ).toBe(200);

    const deleted = await request(
      ctx.h,
      "DELETE",
      `/apps/${fx.appId}/envs/${fx.environmentId}/experiments/${experiment.id}`,
      fx.jwt,
    );
    expect(deleted.status).toBe(200);

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
    expect(body.targetingRules).toEqual([expect.objectContaining({ id: "rule_archived_frozen" })]);
    expect(body.draftTargetingRules).toEqual([
      expect.objectContaining({ id: "rule_archived_draft" }),
    ]);
  });
});
