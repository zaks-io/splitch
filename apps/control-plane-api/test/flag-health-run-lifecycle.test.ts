import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createExperimentDraft,
  endRun,
  type ExperimentRunHarness,
  experimentFixture,
  makeExperimentRunHarness,
  patchExperiment,
  startExperiment,
  type StartResponse,
} from "../src/experiment-run-test-fixture";
import {
  baseFlag,
  createFlag,
  type FlagDefinitionHarness,
  request,
} from "../src/flag-definition-test-harness";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

let h: FlagDefinitionHarness;
let ctx: ExperimentRunHarness;

beforeEach(async () => {
  ctx = await makeExperimentRunHarness(makeLocalBindings);
  h = ctx.h;
});

afterEach(async () => h.bindings.dispose());

function releaseBody(appId: string, key: string, expiresAt: string) {
  const { lifecycleClass: _, ...rest } = baseFlag(appId);
  return {
    ...rest,
    key,
    name: key,
    lifecycleClass: "release" as const,
    owner: "checkout-team",
    expiresAt,
  };
}

async function setRolloutEverywhere(
  appId: string,
  flagId: string,
  percentage: number,
  updatedAt: string,
) {
  await h.bindings.d1
    .prepare(
      `UPDATE flag_configs
       SET enabled = 1,
           available_variant_names = ?,
           rollout = ?,
           updated_at = ?
       WHERE app_id = ? AND flag_id = ?`,
    )
    .bind(
      JSON.stringify(["control", "treatment"]),
      JSON.stringify({ percentage, salt: "stale-test-salt" }),
      updatedAt,
      appId,
      flagId,
    )
    .run();
}

async function markReleaseFlag(appId: string, flagId: string) {
  await h.bindings.d1
    .prepare(
      `UPDATE flags
       SET lifecycle_class = 'release', owner = 'checkout-team', expires_at = ?
       WHERE app_id = ? AND id = ?`,
    )
    .bind("2026-12-01T00:00:00.000Z", appId, flagId)
    .run();
}

describe("stale_flags_list Run lifecycle", () => {
  it("counts the 30-day uniform window from End, not the older Configuration", async () => {
    const fx = await experimentFixture(ctx);
    // Fixture Flags default to permanent `permission` (no uniform signal); release needs it.
    await markReleaseFlag(fx.appId, fx.flag.id);
    await setRolloutEverywhere(fx.appId, fx.flag.id, 100, "2026-05-01T00:00:00.000Z");

    const beforeRun = await request(ctx.h, "GET", `/apps/${fx.appId}/stale-flags`, fx.jwt);
    expect(beforeRun.status).toBe(200);
    const beforeBody = (await beforeRun.json()) as {
      items: Array<{
        flag: { id: string };
        reasons: Array<{ kind: string; uniformSince?: string }>;
        uniformServing: { state: string };
      }>;
    };
    const beforeItem = beforeBody.items.find((item) => item.flag.id === fx.flag.id);
    expect(beforeItem?.uniformServing).toEqual({ state: "available" });
    expect(beforeItem?.reasons.map((reason) => reason.kind)).toContain("uniform_serving");

    const experiment = await createExperimentDraft(ctx, fx, {
      key: "uniform-after-end",
      allocation: { control: 50, treatment: 50 },
      salt: "uniform-after-end-salt",
    });
    const started = (await (await startExperiment(ctx, fx, experiment.id)).json()) as StartResponse;
    expect((await endRun(ctx, fx, started.run.id)).status).toBe(200);

    const afterEnd = await request(ctx.h, "GET", `/apps/${fx.appId}/stale-flags`, fx.jwt);
    expect(afterEnd.status).toBe(200);
    const afterBody = (await afterEnd.json()) as {
      items: Array<{
        flag: { id: string };
        reasons: Array<{ kind: string; uniformSince?: string }>;
      }>;
    };
    const afterItem = afterBody.items.find((item) => item.flag.id === fx.flag.id);
    // End lands at Worker NOW; the May Configuration alone would already be stale.
    expect(afterItem?.reasons.find((reason) => reason.kind === "uniform_serving")).toBeUndefined();
  });

  it("keeps End on Flag A after PATCH reassigns the Experiment to Flag B", async () => {
    const fx = await experimentFixture(ctx);
    await markReleaseFlag(fx.appId, fx.flag.id);
    await setRolloutEverywhere(fx.appId, fx.flag.id, 100, "2026-05-01T00:00:00.000Z");

    const flagB = await createFlag(ctx.h, fx.appId, fx.jwt, {
      ...releaseBody(fx.appId, "flag-b-after-reassign", "2026-12-01T00:00:00Z"),
    });
    await setRolloutEverywhere(fx.appId, flagB.id, 100, "2026-05-01T00:00:00.000Z");

    const experiment = await createExperimentDraft(ctx, fx, {
      key: "reassign-after-end",
      allocation: { control: 50, treatment: 50 },
      salt: "reassign-after-end-salt",
    });
    const started = (await (await startExperiment(ctx, fx, experiment.id)).json()) as StartResponse;
    expect((await endRun(ctx, fx, started.run.id)).status).toBe(200);

    const reassigned = await patchExperiment(ctx, fx, experiment.id, { flagId: flagB.id });
    expect(reassigned.status).toBe(200);

    const res = await request(ctx.h, "GET", `/apps/${fx.appId}/stale-flags`, fx.jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        flag: { id: string };
        reasons: Array<{ kind: string }>;
        uniformServing: { state: string };
      }>;
    };
    const reasonsFor = (flagId: string) =>
      body.items.find((item) => item.flag.id === flagId)?.reasons.map((reason) => reason.kind) ??
      [];

    // A still owns the recent End (via change-log stamp), so old config is not yet stale.
    expect(reasonsFor(fx.flag.id)).not.toContain("uniform_serving");
    // B must not inherit A's Run history; its May config is already past the 30d window.
    expect(reasonsFor(flagB.id)).toContain("uniform_serving");
    expect(body.items.find((item) => item.flag.id === flagB.id)?.uniformServing).toEqual({
      state: "available",
    });
  });

  it("reports unknown uniform serving for an unlogged legacy Run ended inside the window", async () => {
    const fx = await experimentFixture(ctx);
    await markReleaseFlag(fx.appId, fx.flag.id);
    await setRolloutEverywhere(fx.appId, fx.flag.id, 100, "2026-05-01T00:00:00.000Z");

    const experiment = await createExperimentDraft(ctx, fx, {
      key: "legacy-unlogged-end",
      allocation: { control: 50, treatment: 50 },
      salt: "legacy-unlogged-end-salt",
    });
    const started = (await (await startExperiment(ctx, fx, experiment.id)).json()) as StartResponse;
    expect((await endRun(ctx, fx, started.run.id)).status).toBe(200);

    // Strip Start/End change-log rows so the Run looks like a pre-trigger legacy Run.
    await h.bindings.d1
      .prepare(
        `DELETE FROM flag_change_events
         WHERE app_id = ? AND target_type = 'run'
           AND json_extract(diff_json, '$.runId') = ?`,
      )
      .bind(fx.appId, started.run.id)
      .run();
    // End inside the 30-day window relative to Worker NOW (2026-07-02).
    await h.bindings.d1
      .prepare(`UPDATE runs SET ended_at = ? WHERE id = ?`)
      .bind("2026-06-20T00:00:00.000Z", started.run.id)
      .run();

    const res = await request(ctx.h, "GET", `/apps/${fx.appId}/stale-flags`, fx.jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        flag: { id: string };
        reasons: Array<{ kind: string; uniformSince?: string }>;
        uniformServing: { state: string; reason?: string };
      }>;
    };
    const item = body.items.find((entry) => entry.flag.id === fx.flag.id);
    expect(item?.uniformServing).toEqual({
      state: "unknown",
      reason: "run_history_unavailable",
    });
    expect(item?.reasons.find((reason) => reason.kind === "uniform_serving")).toBeUndefined();
  });
});
