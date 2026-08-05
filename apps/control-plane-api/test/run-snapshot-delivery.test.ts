import { envScope } from "@splitch/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configStoreAccess,
  createExperimentDraft,
  experimentFixture,
  makeExperimentRunHarness,
  type StartResponse,
  startExperiment,
} from "../src/experiment-run-test-fixture";
import { makeAppForRepo } from "../src/flag-definition-test-harness";
import type { RunSnapshotDelivery, RunSnapshotRow } from "../src/run-snapshot";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

const captures: Array<{ url: string; init?: RequestInit }> = [];
const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  captures.length = 0;
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

describe("Experiment Start Run Snapshot delivery", () => {
  it("ships one row from the committed direct-start Run", async () => {
    const ctx = await harness(capturingDelivery());
    const fx = await experimentFixture(ctx);
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "snapshot-direct",
      allocation: { control: 40, treatment: 60 },
    });

    const response = await startExperiment(ctx, fx, experiment.id);
    expect(response.status).toBe(200);
    const body = (await response.json()) as StartResponse;
    expect(body.runSnapshotShipped).toBe(true);
    expect(captures).toHaveLength(1);

    const stored = await ctx.repo.experiments.getRun(
      envScope(fx.appId, fx.environmentId),
      body.run.id,
    );
    expect(stored).not.toBeNull();
    const row = capturedRow();
    expect(row).toEqual({
      app_id: fx.appId,
      environment_id: fx.environmentId,
      experiment_id: experiment.id,
      run_id: stored?.id,
      started_at: stored?.startedAt,
      snapshot_at: "2026-07-02T12:00:00.000Z",
      confidence_level: stored?.confidenceLevel,
      horizon: stored?.horizon,
      target_n: stored?.targetN,
      sample_size_locked: stored?.sampleSizeLocked,
      allocation: stored?.allocation,
      control_variant: "control",
      control_variant_id: stored?.controlVariantId,
      // D1 keeps MetricRef[]; the snapshot expands to DecisionFamilyMember[].
      decision_family: analysisDecisionFamilyFromD1(stored?.decisionFamily ?? "[]"),
      guardrail_decisions: stored?.guardrailDecisions,
      dimensions: "[]",
      config_hash: stored?.configHash,
    });
  });

  it("keeps a direct-start Run when delivery fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ctx = await harness(failingDelivery());
    const fx = await experimentFixture(ctx);
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "snapshot-direct-failure",
      allocation: { control: 50, treatment: 50 },
    });

    const response = await startExperiment(ctx, fx, experiment.id);
    const body = (await response.json()) as StartResponse;
    expect(response.status).toBe(200);
    expect(body.runSnapshotShipped).toBe(false);
    await expect(
      ctx.repo.experiments.getRun(envScope(fx.appId, fx.environmentId), body.run.id),
    ).resolves.toMatchObject({ id: body.run.id });
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/^run-snapshot:/u),
      expect.objectContaining({ runId: expect.any(String), fault: expect.any(String) }),
    );
  });

  it("ships an approval-applied Start exactly once", async () => {
    const ctx = await harness(capturingDelivery());
    const fx = await experimentFixture(ctx, "prod");
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "snapshot-approval",
      allocation: { control: 50, treatment: 50 },
    });

    const response = await startExperiment(ctx, fx, experiment.id, {
      review: { action: "approve_and_apply" },
    });
    expect(response.status).toBe(200);
    expect(captures).toHaveLength(1);
    expect(capturedRow()).toMatchObject({ experiment_id: experiment.id });

    const replay = await startExperiment(ctx, fx, experiment.id, {
      review: { action: "approve_and_apply" },
    });
    expect(replay.status).toBe(200);
    expect(captures).toHaveLength(1);
  });

  it("keeps an approval applied when delivery fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ctx = await harness(failingDelivery());
    const fx = await experimentFixture(ctx, "prod");
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "snapshot-approval-failure",
      allocation: { control: 50, treatment: 50 },
    });

    const response = await startExperiment(ctx, fx, experiment.id, {
      review: { action: "approve_and_apply" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ approvalRequest: { status: "applied" } });
    await expect(
      ctx.repo.experiments.listRunsForExperiment(
        envScope(fx.appId, fx.environmentId),
        experiment.id,
      ),
    ).resolves.toHaveLength(1);
  });

  it.each([
    "direct",
    "approval",
  ])("treats missing %s delivery config as a loud miss", async (door) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ctx = await harness(null);
    const fx = await experimentFixture(ctx, door === "approval" ? "prod" : "dev");
    const experiment = await createExperimentDraft(ctx, fx, {
      key: `snapshot-missing-${door}`,
      allocation: { control: 50, treatment: 50 },
    });

    const response = await startExperiment(
      ctx,
      fx,
      experiment.id,
      door === "approval" ? { review: { action: "approve_and_apply" } } : {},
    );
    expect(response.status).toBe(200);
    if (door === "direct") {
      expect(await response.json()).toMatchObject({ runSnapshotShipped: false });
    } else {
      expect(await response.json()).toMatchObject({ approvalRequest: { status: "applied" } });
    }
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/^run-snapshot:/u),
      expect.objectContaining({ runId: expect.any(String), fault: expect.any(String) }),
    );
  });
});

function capturingDelivery(): RunSnapshotDelivery {
  return {
    apiUrl: "https://tinybird.test",
    token: "snapshot-token",
    fetch: async (input, init) => {
      captures.push({ url: input.toString(), init });
      return new Response(null, { status: 200 });
    },
  };
}

function failingDelivery(): RunSnapshotDelivery {
  return {
    ...capturingDelivery(),
    fetch: async () => new Response(null, { status: 503 }),
  };
}

async function harness(runSnapshotDelivery: RunSnapshotDelivery | null) {
  const ctx = await makeExperimentRunHarness(makeLocalBindings);
  ctx.h.app = makeAppForRepo(
    ctx.h,
    ctx.repo,
    configStoreAccess(ctx.repo, ctx.h.bindings.kv),
    undefined,
    runSnapshotDelivery ?? undefined,
  );
  disposers.push(ctx.h.bindings.dispose);
  return ctx;
}

function capturedRow(): RunSnapshotRow {
  expect(captures[0]?.url).toBe("https://tinybird.test/v0/events?name=run_snapshots");
  expect(new Headers(captures[0]?.init?.headers).get("authorization")).toBe(
    "Bearer snapshot-token",
  );
  return JSON.parse(String(captures[0]?.init?.body)) as RunSnapshotRow;
}

function analysisDecisionFamilyFromD1(raw: string): string {
  const refs = JSON.parse(raw) as Array<{ metricId: string }>;
  return JSON.stringify(refs.map((ref) => ({ metric_id: ref.metricId, variant: "treatment" })));
}
