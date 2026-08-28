import { PERSISTED_SEGMENT_REF_MAX_ITEMS } from "@splitch/contracts";
import { envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createExperimentDraft,
  type ExperimentRunHarness,
  experimentFixture,
  makeExperimentRunHarness,
  type StartResponse,
  startExperiment,
} from "../src/experiment-run-test-fixture";
import { errorBody, request } from "../src/flag-definition-test-harness";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

let ctx: ExperimentRunHarness;

beforeEach(async () => {
  ctx = await makeExperimentRunHarness(makeLocalBindings);
});

afterEach(async () => ctx.h.bindings.dispose());

describe("control-plane nested Experiment write bounds", () => {
  it("rejects an unknown MetricRef field before any Experiment write", async () => {
    const fx = await experimentFixture(ctx);
    const before = await experimentCount(fx.appId);
    const res = await request(
      ctx.h,
      "POST",
      `/apps/${fx.appId}/envs/${fx.environmentId}/experiments`,
      fx.jwt,
      {
        appId: fx.appId,
        environmentId: fx.environmentId,
        name: "strict-metrics",
        key: "strict-metrics",
        flagId: fx.flag.id,
        targetingKey: "userId",
        targetingKeyType: "user",
        metrics: [{ metricId: fx.metricId, extra: true }],
      },
    );

    expect(res.status).toBe(400);
    const err = await errorBody(res);
    expect(err.code).toBe("VALIDATION_ERROR");
    if (err.code !== "VALIDATION_ERROR") return;
    expect(err.details.issues).toEqual([
      { path: ["body", "metrics", "0", "extra"], message: 'Unrecognized key: "extra"' },
    ]);
    expect(await experimentCount(fx.appId)).toBe(before);
  });

  it("rejects an unknown Targeting Rule field before any Experiment write", async () => {
    const fx = await experimentFixture(ctx);
    const before = await experimentCount(fx.appId);
    const res = await request(
      ctx.h,
      "POST",
      `/apps/${fx.appId}/envs/${fx.environmentId}/experiments`,
      fx.jwt,
      {
        appId: fx.appId,
        environmentId: fx.environmentId,
        name: "strict-rules",
        key: "strict-rules",
        flagId: fx.flag.id,
        targetingKey: "userId",
        targetingKeyType: "user",
        metrics: [{ metricId: fx.metricId }],
        targetingRules: [
          {
            id: "rule-1",
            flagId: fx.flag.id,
            priority: 0,
            conditions: [{ attribute: "plan", operator: "eq", value: "paid" }],
            variantId: fx.flag.defaultVariantId,
            extra: true,
          },
        ],
      },
    );

    expect(res.status).toBe(400);
    const err = await errorBody(res);
    expect(err.code).toBe("VALIDATION_ERROR");
    if (err.code !== "VALIDATION_ERROR") return;
    expect(err.details.issues).toEqual([
      { path: ["body", "targetingRules", "0", "extra"], message: 'Unrecognized key: "extra"' },
    ]);
    expect(await experimentCount(fx.appId)).toBe(before);
  });

  it("rejects an unknown runs_end field and an over-limit reason before ending the Run", async () => {
    const fx = await experimentFixture(ctx);
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "strict-end",
      allocation: { control: 50, treatment: 50 },
      salt: "strict-end-salt",
    });
    const started = (await (await startExperiment(ctx, fx, experiment.id)).json()) as StartResponse;
    const extra = await request(
      ctx.h,
      "POST",
      `/apps/${fx.appId}/envs/${fx.environmentId}/runs/${started.run.id}/end`,
      fx.jwt,
      { extra: true },
    );
    expect(extra.status).toBe(400);
    const extraErr = await errorBody(extra);
    expect(extraErr.code).toBe("VALIDATION_ERROR");
    if (extraErr.code !== "VALIDATION_ERROR") return;
    expect(extraErr.details.issues).toEqual([
      { path: ["body", "extra"], message: 'Unrecognized key: "extra"' },
    ]);

    const longReason = await request(
      ctx.h,
      "POST",
      `/apps/${fx.appId}/envs/${fx.environmentId}/runs/${started.run.id}/end`,
      fx.jwt,
      { reason: "r".repeat(2001) },
    );
    expect(longReason.status).toBe(400);
    const reasonErr = await errorBody(longReason);
    expect(reasonErr.code).toBe("VALIDATION_ERROR");
    if (reasonErr.code !== "VALIDATION_ERROR") return;
    expect(reasonErr.details.issues.some((issue) => issue.path.join(".") === "body.reason")).toBe(
      true,
    );

    const run = await ctx.repo.experiments.getRun(
      envScope(fx.appId, fx.environmentId),
      started.run.id,
    );
    expect(run).toMatchObject({ status: "running", endedAt: null });
  });

  it("rejects over-limit draft Segment refs before any Experiment write", async () => {
    const fx = await experimentFixture(ctx);
    const before = await experimentCount(fx.appId);
    const res = await request(
      ctx.h,
      "POST",
      `/apps/${fx.appId}/envs/${fx.environmentId}/experiments`,
      fx.jwt,
      {
        appId: fx.appId,
        environmentId: fx.environmentId,
        name: "too-many-segments",
        key: "too-many-segments",
        flagId: fx.flag.id,
        targetingKey: "userId",
        targetingKeyType: "user",
        metrics: [{ metricId: fx.metricId }],
        segmentIds: Array.from(
          { length: PERSISTED_SEGMENT_REF_MAX_ITEMS + 1 },
          (_, index) => `seg_${index}`,
        ),
      },
    );

    expect(res.status).toBe(400);
    const err = await errorBody(res);
    expect(err.code).toBe("VALIDATION_ERROR");
    if (err.code !== "VALIDATION_ERROR") return;
    expect(err.details.issues.some((issue) => issue.path.join(".") === "body.segmentIds")).toBe(
      true,
    );
    expect(await experimentCount(fx.appId)).toBe(before);
  });
});

async function experimentCount(appId: string): Promise<number> {
  const row = await ctx.h.bindings.d1
    .prepare("SELECT COUNT(*) AS n FROM experiments WHERE app_id = ?")
    .bind(appId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
