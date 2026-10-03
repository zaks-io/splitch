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
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

/**
 * Runs created before migration 0035 have null planned_duration_days. Replaying
 * an already-applied Start must still return 200 and omit `next` — inventing a
 * duration would lie about the decision floor, and throwing would turn a
 * successful idempotent retry into a 500.
 */

let ctx: ExperimentRunHarness;

beforeEach(async () => {
  ctx = await makeExperimentRunHarness(makeLocalBindings);
});

afterEach(async () => ctx.h.bindings.dispose());

describe("mutation next after Start against legacy Runs", () => {
  it("replays an applied Start with null plannedDurationDays as 200 without next", async () => {
    const fx = await experimentFixture(ctx, "prod");
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "legacy-next-start",
      allocation: { control: 50, treatment: 50 },
      salt: "legacy-next-start-salt",
    });

    const started = await startExperiment(ctx, fx, experiment.id, {
      review: { action: "approve_and_apply" },
    });
    expect(started.status).toBe(200);
    const startedBody = (await started.json()) as StartResponse & {
      next?: { tool: string };
      run: { id: string; plannedDurationDays?: number | null };
    };
    expect(startedBody.next?.tool).toBe("experiment_results_get");

    await ctx.h.bindings.d1
      .prepare("UPDATE runs SET planned_duration_days = NULL WHERE app_id = ? AND id = ?")
      .bind(fx.appId, startedBody.run.id)
      .run();
    const legacyRun = await ctx.repo.experiments.getRun(
      envScope(fx.appId, fx.environmentId),
      startedBody.run.id,
    );
    expect(legacyRun?.plannedDurationDays).toBeNull();

    const replay = await startExperiment(ctx, fx, experiment.id, {
      review: { action: "approve_and_apply" },
    });
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as StartResponse & { next?: unknown };
    expect(replayBody).not.toHaveProperty("next");
    expect(replayBody.run.id).toBe(startedBody.run.id);
  });
});
