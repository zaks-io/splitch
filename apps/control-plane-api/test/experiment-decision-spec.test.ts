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
import { errorBody, request } from "../src/flag-definition-test-harness";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

/**
 * Rewrites a pending proposal to the shape recorded before the horizon rode the
 * Approval Request. There is no API that can produce one any more, and the
 * whole point of the case is proposals that already exist in a deployed
 * database: an operator cannot edit a frozen proposal to add the field.
 */
async function stripProposedHorizon(
  ctx: ExperimentRunHarness,
  appId: string,
  approvalRequestId: string,
): Promise<void> {
  const row = await ctx.h.bindings.d1
    .prepare("SELECT diff FROM approval_requests WHERE app_id = ? AND id = ?")
    .bind(appId, approvalRequestId)
    .first<{ diff: string }>();
  if (!row) throw new Error(`no Approval Request ${approvalRequestId}`);
  const diff = JSON.parse(row.diff) as { proposed: Record<string, unknown> };
  delete diff.proposed.horizon;
  delete diff.proposed.sampleSizeLocked;
  await ctx.h.bindings.d1
    .prepare("UPDATE approval_requests SET diff = ? WHERE app_id = ? AND id = ?")
    .bind(JSON.stringify(diff), appId, approvalRequestId)
    .run();
}

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

  /**
   * A gated Start records its intent on the Approval Request, and the
   * Idempotency-Key is what says "this is that same request again". If the key's
   * identity does not cover the decision spec, a retry that asks for a DIFFERENT
   * stopping rule replays the stale proposal and answers 200 — telling the
   * caller their request succeeded while the Run froze something else entirely.
   */
  it("refuses a same-key Start whose decision spec changed and replays an identical one", async () => {
    const fx = await experimentFixture(ctx, "prod");
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "changed-intent",
      allocation: { control: 50, treatment: 50 },
    });
    const scope = envScope(fx.appId, fx.environmentId);

    const first = await startExperiment(ctx, fx, experiment.id, {
      horizon: "fixed",
      sampleSizeLocked: 5000,
    });
    expect(first.status).toBe(409);
    expect((await errorBody(first)).code).toBe("APPROVAL_REVIEW_REQUIRED");

    const changed = await startExperiment(ctx, fx, experiment.id, {
      horizon: "sequential",
      sampleSizeLocked: null,
      review: { action: "approve_and_apply" },
    });
    expect(changed.status).toBe(409);
    expect(await errorBody(changed)).toMatchObject({
      code: "IDEMPOTENCY_KEY_CONFLICT",
      details: { scope: "approval_request" },
    });
    expect(await ctx.repo.experiments.listRunsForExperiment(scope, experiment.id)).toEqual([]);

    const identical = await startExperiment(ctx, fx, experiment.id, {
      horizon: "fixed",
      sampleSizeLocked: 5000,
      review: { action: "approve_and_apply" },
    });
    expect(identical.status).toBe(200);
    const { run } = (await identical.json()) as StartResponse;
    const frozen = await ctx.repo.experiments.getRun(scope, run.id);
    expect(frozen?.horizon).toBe("fixed");
    expect(frozen?.sampleSizeLocked).toBe(5000);
  });

  /**
   * A pending `experiment_start` proposal recorded before the horizon rode the
   * Approval carries none. It was proposed under the documented default, and an
   * operator cannot edit a frozen proposal to add the field, so refusing it
   * would be a refusal with no remedy (ADR-0036).
   */
  it("applies a pending proposal with no recorded horizon as sequential", async () => {
    const fx = await experimentFixture(ctx, "prod");
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "legacy-proposal",
      allocation: { control: 50, treatment: 50 },
    });
    const scope = envScope(fx.appId, fx.environmentId);

    const proposed = await startExperiment(ctx, fx, experiment.id);
    expect(proposed.status).toBe(409);
    const approvalRequestId = (await errorBody(proposed)).details.approvalRequestId as string;
    await stripProposedHorizon(ctx, fx.appId, approvalRequestId);

    const reviewed = await request(
      ctx.h,
      "POST",
      `/apps/${fx.appId}/approval-requests/${approvalRequestId}/reviews`,
      fx.jwt,
      { action: "approve_and_apply", idempotency_key: "idem_review_legacy" },
    );
    expect(reviewed.status).toBe(200);

    const current = await ctx.repo.experiments.getExperiment(scope, experiment.id);
    const run = current?.liveRunId
      ? await ctx.repo.experiments.getRun(scope, current.liveRunId)
      : null;
    expect(run?.horizon).toBe("sequential");
    expect(run?.sampleSizeLocked).toBe(null);
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
