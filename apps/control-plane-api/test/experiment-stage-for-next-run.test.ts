import { parsePanelExperimentDetailOutput } from "@splitch/control-plane-sdk/panel-experiments";
import { appScope, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createExperimentDraft,
  endRun,
  type ExperimentRunHarness,
  experimentFixture,
  type Fixture,
  makeExperimentRunHarness,
  patchExperiment,
  startExperiment,
  type StartResponse,
} from "../src/experiment-run-test-fixture";
import { baseFlag, createFlag, errorBody } from "../src/flag-definition-test-harness";
import { callPanelExperimentDetail } from "./panel-detail-request";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

let ctx: ExperimentRunHarness;

beforeEach(async () => {
  ctx = await makeExperimentRunHarness(makeLocalBindings);
});

afterEach(async () => ctx.h.bindings.dispose());

async function runningExperiment(key: string) {
  const fx = await experimentFixture(ctx);
  const experiment = await createExperimentDraft(ctx, fx, {
    key,
    allocation: { control: 50, treatment: 50 },
    salt: "run-1-salt",
  });
  await ctx.repo.identity.updateEnvironment(appScope(fx.appId), fx.environmentId, {
    policy: JSON.stringify({
      variantAvailability: "allow",
      targetingRolloutValue: "allow",
      enabledState: "allow",
      startExperimentRun: "allow",
    }),
  });
  const started = await startExperiment(ctx, fx, experiment.id);
  expect(started.status).toBe(200);
  return { fx, experimentId: experiment.id, run: ((await started.json()) as StartResponse).run };
}

function liveRow(fx: Fixture, experimentId: string) {
  return ctx.repo.experiments.getExperiment(envScope(fx.appId, fx.environmentId), experimentId);
}

describe("stageForNextRun never mutates the live Experiment row", () => {
  it("rejects assignment-identity fields that have no draft column and leaves D1 untouched", async () => {
    const { fx, experimentId, run } = await runningExperiment("stage-identity");
    const before = await liveRow(fx, experimentId);
    const otherFlag = await createFlag(ctx.h, fx.appId, fx.jwt, {
      ...baseFlag(fx.appId),
      key: "other-flag",
      name: "Other flag",
    });

    const cases: Array<[string, Record<string, unknown>]> = [
      ["experiment.targetingKeyType", { targetingKeyType: "workspace" }],
      ["experiment.targetingKey", { targetingKey: "orgId" }],
      ["experiment.flagId", { flagId: otherFlag.id }],
      ["experiment.activationMetricId", { activationMetricId: fx.metricId }],
    ];

    for (const [field, patch] of cases) {
      const res = await patchExperiment(ctx, fx, experimentId, {
        stageForNextRun: true,
        ...patch,
      });
      expect(res.status, field).toBe(409);
      const body = await errorBody(res);
      expect(body, field).toMatchObject({
        code: "RUN_FROZEN",
        details: {
          frozenFields: [field],
          currentRunId: run.id,
          attemptedChange: "PATCH_EXPERIMENT_STAGE_FOR_NEXT_RUN",
          recommendedAction: "END_RUNNING_RUN_FIRST",
        },
      });
      expect(body.message, field).toContain(field);

      // The published ExperimentConfig reads these off the live row, so a
      // partial write here would repoint a frozen Run.
      expect(await liveRow(fx, experimentId), field).toMatchObject({
        flagId: before?.flagId,
        targetingKeyField: before?.targetingKeyField,
        targetingKeyType: before?.targetingKeyType,
        activationMetricId: before?.activationMetricId,
        liveRunId: run.id,
      });
    }

    // Re-sending the unchanged current values is a no-op, not a rejection:
    // that is what the Panel's pre-filled next-Run form does.
    const unchanged = await patchExperiment(ctx, fx, experimentId, {
      stageForNextRun: true,
      targetingKey: before?.targetingKeyField,
      targetingKeyType: before?.targetingKeyType,
      activationMetricId: before?.activationMetricId,
      allocation: { control: 70, treatment: 30 },
    });
    expect(unchanged.status).toBe(200);
  });

  it("merges sequential staged edits instead of reverting the previous one", async () => {
    const { fx, experimentId } = await runningExperiment("stage-merge");
    const rules = [
      {
        id: "rule_stage",
        flagId: fx.flag.id,
        priority: 1,
        conditions: [{ attribute: "plan", operator: "eq", value: "paid" }],
        variantId: fx.flag.defaultVariantId,
      },
    ];

    const first = await patchExperiment(ctx, fx, experimentId, {
      stageForNextRun: true,
      targetingRules: rules,
      salt: "staged-salt",
      segmentIds: [fx.segmentId],
    });
    expect(first.status).toBe(200);

    const second = await patchExperiment(ctx, fx, experimentId, {
      stageForNextRun: true,
      allocation: { control: 60, treatment: 40 },
    });
    expect(second.status).toBe(200);

    const staged = await liveRow(fx, experimentId);
    expect(staged).toMatchObject({
      draftAllocation: JSON.stringify({ control: 60, treatment: 40 }),
      draftSalt: "staged-salt",
      draftSegmentIds: JSON.stringify([fx.segmentId]),
    });
    expect(JSON.parse(staged?.draftTargetingRules ?? "[]")).toHaveLength(1);
    expect(JSON.parse(staged?.draftTargetingRules ?? "[]")[0]).toMatchObject({ id: "rule_stage" });

    // A third stage touching only targeting must not revert the allocation.
    const third = await patchExperiment(ctx, fx, experimentId, {
      stageForNextRun: true,
      targetingRules: [],
    });
    expect(third.status).toBe(200);
    expect(await liveRow(fx, experimentId)).toMatchObject({
      draftAllocation: JSON.stringify({ control: 60, treatment: 40 }),
      draftSalt: "staged-salt",
      draftSegmentIds: JSON.stringify([fx.segmentId]),
      draftTargetingRules: "[]",
    });
  });

  // A Run freezes the Targeting Rules its Segment references resolved to and
  // stores no reference list of its own, so if the Panel's detail response drops
  // `draftSegmentIds` the staged references become unreadable and unrenderable.
  it("returns staged Segment references through the Panel detail contract", async () => {
    const { fx, experimentId } = await runningExperiment("stage-segments-roundtrip");

    const staged = await patchExperiment(ctx, fx, experimentId, {
      stageForNextRun: true,
      segmentIds: [fx.segmentId],
    });
    expect(staged.status).toBe(200);

    const response = await callPanelExperimentDetail({
      appId: fx.appId,
      environmentId: fx.environmentId,
      experimentId,
    });
    expect(response.status).toBe(200);

    // Asserting the raw JSON here would prove only that the Worker emits *a*
    // field; it would still pass if the Panel's parser dropped it. Running the
    // real parser over the real response closes the round trip.
    const parsed = parsePanelExperimentDetailOutput(await response.json());
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.experiment.draftSegmentIds).toEqual([fx.segmentId]);
  });

  // The handler used to read the running Run a second time to decide how to
  // build the patch. If the Run ended in between, the two reads disagreed and
  // the write ran under rules the guard never applied to it.
  it("keeps staged draft fields when the Run ends before the next stage", async () => {
    const { fx, experimentId, run } = await runningExperiment("stage-after-end");

    const first = await patchExperiment(ctx, fx, experimentId, {
      stageForNextRun: true,
      salt: "staged-salt",
      segmentIds: [fx.segmentId],
    });
    expect(first.status).toBe(200);

    expect((await endRun(ctx, fx, run.id)).status).toBe(200);

    const second = await patchExperiment(ctx, fx, experimentId, {
      stageForNextRun: true,
      allocation: { control: 10, treatment: 90 },
    });
    expect(second.status).toBe(200);

    expect(await liveRow(fx, experimentId)).toMatchObject({
      draftAllocation: JSON.stringify({ control: 10, treatment: 90 }),
      draftSalt: "staged-salt",
      draftSegmentIds: JSON.stringify([fx.segmentId]),
    });
  });

  it("rejects variantSet and points at the Flag Variant catalog", async () => {
    const { fx, experimentId } = await runningExperiment("stage-variant-set");
    const res = await patchExperiment(ctx, fx, experimentId, {
      stageForNextRun: true,
      variantSet: [{ id: fx.flag.defaultVariantId, name: "control", value: false }],
    });
    expect(res.status).toBe(400);
    const body = await errorBody(res);
    expect(body.code).toBe("VALIDATION_ERROR");
    const issues = (body.details as { issues: Array<{ path: string[]; message: string }> }).issues;
    expect(issues[0]?.path).toEqual(["body", "variantSet"]);
    expect(issues[0]?.message).toContain("Flag's Variant catalog");
    expect(await liveRow(fx, experimentId)).toMatchObject({ draftAllocation: null });
  });
});
