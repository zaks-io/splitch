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
import { errorBody } from "../src/flag-definition-test-harness";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

let ctx: ExperimentRunHarness;

beforeEach(async () => {
  ctx = await makeExperimentRunHarness(makeLocalBindings);
});

afterEach(async () => ctx.h.bindings.dispose());

/**
 * The decision spec is what makes a Run's result decidable, and Start is the last
 * moment it can be fixed (ADR-0002 Run immutability, ADR-0003 assignment vs
 * measurement edits). These are the Worker-side refusals the creation flow leans
 * on: the Panel renders them, it does not decide them (ADR-0023).
 */
describe("Experiment decision spec at Start", () => {
  it("refuses Start with an empty goal Metric family, naming what is missing", async () => {
    const fx = await experimentFixture(ctx);
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "no-goal-metric",
      allocation: { control: 50, treatment: 50 },
      metrics: [],
    });

    const response = await startExperiment(ctx, fx, experiment.id);

    expect(response.status).toBe(400);
    const error = await errorBody(response);
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.details.issues[0]?.path).toEqual(["experiment", "metrics"]);
    expect(error.details.issues[0]?.message).toMatch(/goal Metric/);
  });

  it("refuses a fixed horizon with no pre-registered sample size and accepts one with it", async () => {
    const fx = await experimentFixture(ctx);
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "fixed-horizon",
      allocation: { control: 50, treatment: 50 },
    });

    const missing = await startExperiment(ctx, fx, experiment.id, { horizon: "fixed" });
    expect(missing.status).toBe(400);
    const error = await errorBody(missing);
    expect(error.details.issues[0]?.path).toEqual(["body", "sampleSizeLocked"]);

    const started = await startExperiment(ctx, fx, experiment.id, {
      horizon: "fixed",
      sampleSizeLocked: 4000,
    });
    expect(started.status).toBe(200);
    const body = (await started.json()) as StartResponse;
    const run = await ctx.repo.experiments.getRun(
      envScope(fx.appId, fx.environmentId),
      body.run.id,
    );
    expect(run?.horizon).toBe("fixed");
    expect(run?.sampleSizeLocked).toBe(4000);
  });

  it("locks the decision spec once a Run froze it", async () => {
    const fx = await experimentFixture(ctx);
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "locked-decision-spec",
      allocation: { control: 50, treatment: 50 },
      confidenceLevel: 0.95,
      dimensions: ["country"],
    });
    const preStart = await patchExperiment(ctx, fx, experiment.id, { confidenceLevel: 0.9 });
    expect(preStart.status).toBe(200);

    const started = await startExperiment(ctx, fx, experiment.id);
    expect(started.status).toBe(200);
    const { run } = (await started.json()) as StartResponse;

    for (const patch of [{ confidenceLevel: 0.99 }, { dimensions: ["plan"] }]) {
      const refused = await patchExperiment(ctx, fx, experiment.id, patch);
      expect(refused.status).toBe(409);
      const error = await errorBody(refused);
      expect(error.code).toBe("DECISION_LOCKED");
      expect(error.details.currentRunId).toBe(run.id);
      expect(error.details.recommendedAction).toBe("CREATE_NEW_RUN");
      expect(error.details.lockedFields).toEqual(Object.keys(patch));
    }
  });
});
