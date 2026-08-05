import { appScope, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createExperimentDraft,
  type ExperimentRunHarness,
  experimentFixture,
  makeExperimentRunHarness,
  type StartResponse,
  startExperiment,
} from "../src/experiment-run-test-fixture";
import { errorBody } from "../src/flag-definition-test-harness";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

/**
 * Start is the only moment the analysis knobs can be fixed: a Metric edited
 * mid-Run must not restate a decided result. Guardrails carry a bound that is
 * per (Metric, Variant) because Control is the baseline, not a subject of the
 * check, and the variance-reduction rule is per Metric (variance-reduction.md).
 */

const NOW_ISO = "2026-07-02T12:00:00.000Z";

let ctx: ExperimentRunHarness;

beforeEach(async () => {
  ctx = await makeExperimentRunHarness(makeLocalBindings);
});

afterEach(async () => ctx.h.bindings.dispose());

async function metric(
  appId: string,
  id: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const row = await ctx.repo.experiments.metrics.insert(appScope(appId), {
    id,
    appId,
    key: id,
    name: id,
    kind: "binomial",
    eventName: id,
    createdAt: NOW_ISO,
    ...overrides,
  });
  return row.id;
}

describe("Experiment Start freezes the analysis config", () => {
  it("freezes a guardrail bound against the treatment Variant, never the Control", async () => {
    const fx = await experimentFixture(ctx);
    const guardrailId = await metric(fx.appId, "metric_errors", { downsideThresholdPct: -2 });
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "guardrail-freeze",
      allocation: { control: 50, treatment: 50 },
      guardrailMetrics: [{ metricId: guardrailId }],
    });

    const response = await startExperiment(ctx, fx, experiment.id);

    expect(response.status).toBe(200);
    const body = (await response.json()) as StartResponse;
    const run = await ctx.repo.experiments.getRun(
      envScope(fx.appId, fx.environmentId),
      body.run.id,
    );
    expect(JSON.parse(run?.guardrailDecisions ?? "[]")).toEqual([
      {
        metric_id: guardrailId,
        variant: "treatment",
        downside_threshold_pct: -2,
        guardrail_locked_at_run_start: true,
        threshold_locked_at_run_start: true,
      },
    ]);
  });

  it("refuses a guardrail Metric that states no bound", async () => {
    // A guardrail with no threshold is a guardrail that can never breach, which
    // reads on the results screen as "checked and fine".
    const fx = await experimentFixture(ctx);
    const guardrailId = await metric(fx.appId, "metric_unbounded");
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "guardrail-unbounded",
      allocation: { control: 50, treatment: 50 },
      guardrailMetrics: [{ metricId: guardrailId }],
    });

    const response = await startExperiment(ctx, fx, experiment.id);

    expect(response.status).toBe(400);
    const body = await errorBody(response);
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(JSON.stringify(body.details)).toContain(guardrailId);
  });

  it("resolves each analyzed Metric's variance rule, defaults included", async () => {
    const fx = await experimentFixture(ctx);
    const revenueId = await metric(fx.appId, "metric_revenue", {
      kind: "revenue",
      eventValueField: "amount",
      winsorizePct: 99,
    });
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "variance-freeze",
      allocation: { control: 50, treatment: 50 },
      metrics: [{ metricId: fx.metricId }, { metricId: revenueId }],
    });

    const response = await startExperiment(ctx, fx, experiment.id);

    expect(response.status).toBe(200);
    const body = (await response.json()) as StartResponse;
    const run = await ctx.repo.experiments.getRun(
      envScope(fx.appId, fx.environmentId),
      body.run.id,
    );
    const frozen = JSON.parse(run?.metricVarianceConfig ?? "[]") as Array<Record<string, unknown>>;
    expect(frozen).toContainEqual({
      metric_id: fx.metricId,
      // Binomial values are 0/1, so there is no tail to trim regardless of what
      // the Metric asks for.
      winsorize: false,
      winsorize_pct: 99.9,
      cuped: true,
      cuped_coverage_threshold_pct: 70,
    });
    expect(frozen).toContainEqual({
      metric_id: revenueId,
      winsorize: true,
      winsorize_pct: 99,
      cuped: true,
      cuped_coverage_threshold_pct: 70,
    });
  });

  it("freezes CUPED off for a Metric that opted out and for every Ratio Metric", async () => {
    // A Ratio Metric's estimand is a ratio of means, which the CUPED regression
    // is not fit on, so it is off regardless of what the Metric asks for.
    const fx = await experimentFixture(ctx);
    const optedOutId = await metric(fx.appId, "metric_opted_out", { cuped: false });
    const ratioId = await metric(fx.appId, "metric_ratio", {
      kind: "ratio",
      denominatorMetricId: fx.metricId,
      cuped: true,
    });
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "cuped-off-freeze",
      allocation: { control: 50, treatment: 50 },
      metrics: [{ metricId: optedOutId }, { metricId: ratioId }],
    });

    const response = await startExperiment(ctx, fx, experiment.id);

    expect(response.status).toBe(200);
    const body = (await response.json()) as StartResponse;
    const run = await ctx.repo.experiments.getRun(
      envScope(fx.appId, fx.environmentId),
      body.run.id,
    );
    const frozen = JSON.parse(run?.metricVarianceConfig ?? "[]") as Array<Record<string, unknown>>;
    expect(frozen.find((row) => row.metric_id === optedOutId)?.cuped).toBe(false);
    expect(frozen.find((row) => row.metric_id === ratioId)?.cuped).toBe(false);
  });
});
