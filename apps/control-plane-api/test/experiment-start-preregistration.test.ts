import { envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configStoreAccess,
  createExperimentDraft,
  type ExperimentRunHarness,
  experimentFixture,
  makeExperimentRunHarness,
  startExperiment,
} from "../src/experiment-run-test-fixture";
import { makeAppForRepo, request } from "../src/flag-definition-test-harness";
import type { RunSnapshotDelivery, RunSnapshotRow } from "../src/run-snapshot";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

const validShipRule = {
  requiredMargin: 0.02,
  marginScale: "absolute" as const,
  conflictResolution: "primary_wins" as const,
};

function validPreRegistration(metricId: string) {
  return {
    hypothesis: "Treatment raises the goal by at least 2pp",
    primaryMetricId: metricId,
    metrics: [
      {
        metricId,
        desirability: "higher_is_better" as const,
        mdeAbsolute: 0.02,
        rope: { lower: -0.005, upper: 0.005, scale: "absolute" as const },
      },
    ],
    shipRule: validShipRule,
  };
}

function expectedFrozen(metricId: string) {
  return {
    hypothesis: "Treatment raises the goal by at least 2pp",
    primary_metric_id: metricId,
    metrics: [
      {
        metric_id: metricId,
        desirability: "higher_is_better",
        mde_absolute: 0.02,
        rope: { lower: -0.005, upper: 0.005, scale: "absolute" },
      },
    ],
    ship_rule: {
      required_margin: 0.02,
      margin_scale: "absolute",
      conflict_resolution: "primary_wins",
    },
    futility: "off",
  };
}

function expectedRunIntent(metricId: string) {
  return { ...validPreRegistration(metricId), futility: "off" as const };
}

const captures: Array<{ url: string; init?: RequestInit }> = [];
const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  captures.length = 0;
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

describe("experiments_start pre-registration validation codes", () => {
  let ctx: ExperimentRunHarness;

  beforeEach(async () => {
    ctx = await makeExperimentRunHarness(makeLocalBindings);
    disposers.push(ctx.h.bindings.dispose);
  });

  it("returns PREREG_HYPOTHESIS_REQUIRED for an empty hypothesis", async () => {
    const fx = await experimentFixture(ctx);
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "prereg-hypothesis",
      allocation: { control: 50, treatment: 50 },
      salt: "prereg-hypothesis-salt",
    });

    const response = await startExperiment(ctx, fx, experiment.id, {
      preRegistration: {
        hypothesis: "",
        primaryMetricId: fx.metricId,
        metrics: [{ metricId: fx.metricId, desirability: "higher_is_better" }],
        shipRule: validShipRule,
      },
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      code: string;
      details: { issues: Array<{ code?: string; path: string[] }> };
    };
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.details.issues.map((issue) => issue.code)).toContain("PREREG_HYPOTHESIS_REQUIRED");
  });

  it("returns PREREG_SHIP_RULE_INVALID for a zero requiredMargin", async () => {
    const fx = await experimentFixture(ctx);
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "prereg-ship-rule",
      allocation: { control: 50, treatment: 50 },
      salt: "prereg-ship-rule-salt",
    });

    const response = await startExperiment(ctx, fx, experiment.id, {
      preRegistration: {
        hypothesis: "Treatment raises the goal",
        primaryMetricId: fx.metricId,
        metrics: [{ metricId: fx.metricId, desirability: "higher_is_better" }],
        shipRule: { ...validShipRule, requiredMargin: 0 },
      },
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      code: string;
      details: { issues: Array<{ code?: string; path: string[] }> };
    };
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.details.issues.map((issue) => issue.code)).toContain("PREREG_SHIP_RULE_INVALID");
  });

  it("returns PREREG_ROPE_RELATIVE_UNSUPPORTED for a relative ROPE", async () => {
    const fx = await experimentFixture(ctx);
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "prereg-relative-rope",
      allocation: { control: 50, treatment: 50 },
      salt: "prereg-relative-rope-salt",
    });

    const response = await startExperiment(ctx, fx, experiment.id, {
      preRegistration: {
        ...validPreRegistration(fx.metricId),
        metrics: [
          {
            metricId: fx.metricId,
            desirability: "higher_is_better",
            rope: { lower: -0.05, upper: 0.05, scale: "relative" },
          },
        ],
      },
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      code: string;
      details: { issues: Array<{ code?: string; path: string[] }> };
    };
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.details.issues.map((issue) => issue.code)).toContain(
      "PREREG_ROPE_RELATIVE_UNSUPPORTED",
    );
  });
});

describe("experiments_start pre-registration success path", () => {
  it.each([
    { door: "direct", environmentKey: "dev", startBody: {} },
    {
      door: "approval-gated",
      environmentKey: "prod",
      startBody: { review: { action: "approve_and_apply" } },
    },
  ] as const)(
    "freezes pre-registration on $door Start (D1, response, GET, snapshot)",
    async ({ environmentKey, startBody }) => {
      const ctx = await harnessWithSnapshotCapture();
      const fx = await experimentFixture(ctx, environmentKey);
      const experiment = await createExperimentDraft(ctx, fx, {
        key: `prereg-success-${environmentKey}`,
        allocation: { control: 50, treatment: 50 },
        salt: `prereg-success-${environmentKey}-salt`,
      });
      const preRegistration = validPreRegistration(fx.metricId);
      const frozen = expectedFrozen(fx.metricId);

      const response = await startExperiment(ctx, fx, experiment.id, {
        ...startBody,
        preRegistration,
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        run: { id: string; preRegistration?: unknown };
      };
      expect(body.run.preRegistration).toEqual(expectedRunIntent(fx.metricId));

      const stored = await ctx.repo.experiments.getRun(
        envScope(fx.appId, fx.environmentId),
        body.run.id,
      );
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored?.preRegistration ?? "null")).toEqual(frozen);

      const read = await request(
        ctx.h,
        "GET",
        `/apps/${fx.appId}/envs/${fx.environmentId}/experiments/${experiment.id}/runs/${body.run.id}`,
        fx.jwt,
      );
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({
        id: body.run.id,
        preRegistration: expectedRunIntent(fx.metricId),
      });

      expect(captures).toHaveLength(1);
      const snapshot = capturedRow();
      expect(JSON.parse(snapshot.pre_registration ?? "null")).toEqual(frozen);
    },
  );

  it("preserves the frozen pre-registration on approval-gated idempotent replay", async () => {
    const ctx = await harnessWithSnapshotCapture();
    const fx = await experimentFixture(ctx, "prod");
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "prereg-success-replay",
      allocation: { control: 50, treatment: 50 },
      salt: "prereg-success-replay-salt",
    });
    const preRegistration = validPreRegistration(fx.metricId);
    const frozen = expectedFrozen(fx.metricId);
    const startBody = { review: { action: "approve_and_apply" }, preRegistration };

    const response = await startExperiment(ctx, fx, experiment.id, startBody);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { run: { id: string; preRegistration?: unknown } };
    expect(body.run.preRegistration).toEqual(expectedRunIntent(fx.metricId));
    expect(captures).toHaveLength(1);

    const replay = await startExperiment(ctx, fx, experiment.id, startBody);
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as {
      run: { id: string; preRegistration?: unknown };
    };
    expect(replayBody.run.id).toBe(body.run.id);
    expect(replayBody.run.preRegistration).toEqual(expectedRunIntent(fx.metricId));
    // Replay must not re-ship the snapshot.
    expect(captures).toHaveLength(1);

    const storedAfterReplay = await ctx.repo.experiments.getRun(
      envScope(fx.appId, fx.environmentId),
      body.run.id,
    );
    expect(JSON.parse(storedAfterReplay?.preRegistration ?? "null")).toEqual(frozen);
  });
});

async function harnessWithSnapshotCapture(): Promise<ExperimentRunHarness> {
  const ctx = await makeExperimentRunHarness(makeLocalBindings);
  const delivery: RunSnapshotDelivery = {
    apiUrl: "https://tinybird.test",
    token: "snapshot-token",
    fetch: async (input, init) => {
      captures.push({ url: input.toString(), init });
      return new Response(null, { status: 200 });
    },
  };
  ctx.h.app = makeAppForRepo(
    ctx.h,
    ctx.repo,
    configStoreAccess(ctx.repo, ctx.h.bindings.kv),
    undefined,
    delivery,
  );
  disposers.push(ctx.h.bindings.dispose);
  return ctx;
}

function capturedRow(): RunSnapshotRow {
  expect(captures[0]?.url).toBe("https://tinybird.test/v0/events?name=run_snapshots");
  return JSON.parse(String(captures[0]?.init?.body)) as RunSnapshotRow;
}
