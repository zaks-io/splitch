import { describe, expect, it, vi } from "vitest";
import type { AnalysisResultsReader } from "./attention-rollup";
import {
  ANALYSIS_READ_CONCURRENCY,
  ANALYSIS_READ_LIMIT,
  ENVIRONMENT_FANOUT_LIMIT,
} from "./attention-rollup";
import {
  ATTENTION_TEST_TIMEOUT,
  authFor,
  DEV_EXPERIMENT_ID,
  type EnvironmentAttentionItem,
  harness,
  itemFor,
  QA_ENVIRONMENT_ID,
  repository,
  seedEnvironments,
  seedRunningExperiments,
  setupAttentionRollupFixture,
  spyOnPlanningReads,
  statsOutput,
  USER_ID,
} from "./attention-rollup-fixture";
import { ids } from "./config-store-fixture-data";

setupAttentionRollupFixture();

describe("GET /apps/:appId/attention-rollup", { timeout: ATTENTION_TEST_TIMEOUT }, () => {
  it("marks only the Environment whose current results carry SRM/Guardrail attention", async () => {
    const calls: Array<{ appId: string; environmentId: string; experimentId: string }> = [];
    const analysisResults: AnalysisResultsReader = {
      async read(scope, actorId) {
        expect(actorId).toBe(USER_ID);
        calls.push(scope);
        return scope.environmentId === ids.environmentId
          ? statsOutput({ srm: true, guardrail: true })
          : statsOutput({ srm: false, guardrail: false });
      },
    };
    const app = harness(analysisResults, authFor(ids.appId, USER_ID));

    const response = await app.request(`/apps/${ids.appId}/attention-rollup`, {
      headers: { authorization: "Bearer valid" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      appId: ids.appId,
      items: [
        {
          environmentId: ids.devEnvironmentId,
          state: "clear",
          srm: false,
          guardrail: false,
        },
        {
          environmentId: ids.environmentId,
          state: "attention",
          srm: true,
          guardrail: true,
        },
        {
          environmentId: QA_ENVIRONMENT_ID,
          state: "no_data",
          srm: false,
          guardrail: false,
        },
      ],
    });
    expect(calls).toEqual([
      {
        appId: ids.appId,
        environmentId: ids.devEnvironmentId,
        experimentId: DEV_EXPERIMENT_ID,
        runId: "run_attention_dev",
      },
      {
        appId: ids.appId,
        environmentId: ids.environmentId,
        experimentId: ids.experimentId,
        runId: ids.liveRunId,
      },
    ]);
  });

  it("keeps srm and guardrail attention distinct per Environment", async () => {
    // Seeded so that swapping the two booleans, or collapsing either into the
    // other, changes this expectation: dev carries SRM only, prod Guardrail only.
    const analysisResults: AnalysisResultsReader = {
      async read(scope) {
        return scope.environmentId === ids.devEnvironmentId
          ? statsOutput({ srm: true, guardrail: false })
          : statsOutput({ srm: false, guardrail: true });
      },
    };
    const app = harness(analysisResults, authFor(ids.appId, USER_ID));

    const response = await app.request(`/apps/${ids.appId}/attention-rollup`, {
      headers: { authorization: "Bearer valid" },
    });
    const body = (await response.json()) as { items: EnvironmentAttentionItem[] };

    expect(response.status).toBe(200);
    expect(itemFor(body.items, ids.devEnvironmentId)).toEqual({
      environmentId: ids.devEnvironmentId,
      state: "attention",
      srm: true,
      guardrail: false,
    });
    expect(itemFor(body.items, ids.environmentId)).toEqual({
      environmentId: ids.environmentId,
      state: "attention",
      srm: false,
      guardrail: true,
    });
  });

  it("raises srm attention for an activation-balance mismatch, matching the Experiment list", async () => {
    // The Experiment list counts activation_balance_mismatch as SRM firing. The
    // rollup shares that predicate, so this Environment must not read as clear.
    const app = harness(
      {
        async read() {
          return statsOutput({ activationBalance: true });
        },
      },
      authFor(ids.appId, USER_ID),
    );

    const response = await app.request(`/apps/${ids.appId}/attention-rollup`, {
      headers: { authorization: "Bearer valid" },
    });
    const body = (await response.json()) as { items: EnvironmentAttentionItem[] };

    expect(response.status).toBe(200);
    expect(itemFor(body.items, ids.environmentId)).toEqual({
      environmentId: ids.environmentId,
      state: "attention",
      srm: true,
      guardrail: false,
    });
  });

  it("makes an Environment with only result 404s explicitly no_data", async () => {
    const app = harness(
      {
        async read() {
          return null;
        },
      },
      authFor(ids.appId, USER_ID),
    );

    const response = await app.request(`/apps/${ids.appId}/attention-rollup`, {
      headers: { authorization: "Bearer valid" },
    });
    const body = (await response.json()) as { items: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(body.items).toEqual(
      expect.arrayContaining([
        {
          environmentId: ids.environmentId,
          state: "no_data",
          srm: false,
          guardrail: false,
        },
      ]),
    );
  });
});

describe("attention rollup Analysis fan-out bounds", { timeout: ATTENTION_TEST_TIMEOUT }, () => {
  // Both budgets are pinned to literals here, not derived from the imported
  // constants: setup and expectation computed from the same constant move
  // together, so raising production to 201 would leave the pair green.
  it("pins both fan-out budgets to their documented values", () => {
    expect(ANALYSIS_READ_LIMIT).toBe(200);
    expect(ENVIRONMENT_FANOUT_LIMIT).toBe(200);
  });

  // Exercised at the exact boundary. `> LIMIT` and `>= LIMIT` disagree only on
  // the limit itself, so testing 202-vs-refused would pass for either.
  it("allows a rollup of exactly 200 Analysis reads", async () => {
    const repo = repository();
    // Two running Experiments already exist (dev + prod), so seed 198.
    await seedRunningExperiments(repo, QA_ENVIRONMENT_ID, 198);
    const read = vi.fn<AnalysisResultsReader["read"]>().mockResolvedValue(statsOutput());
    const app = harness({ read }, authFor(ids.appId, USER_ID));

    const response = await app.request(`/apps/${ids.appId}/attention-rollup`, {
      headers: { authorization: "Bearer valid" },
    });

    expect(response.status).toBe(200);
    expect(read).toHaveBeenCalledTimes(200);
  });

  it("refuses the 201st Analysis read instead of truncating", async () => {
    const repo = repository();
    await seedRunningExperiments(repo, QA_ENVIRONMENT_ID, 199);
    const read = vi.fn<AnalysisResultsReader["read"]>();
    const app = harness({ read }, authFor(ids.appId, USER_ID));

    const response = await app.request(`/apps/${ids.appId}/attention-rollup`, {
      headers: { authorization: "Bearer valid" },
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "ATTENTION_FANOUT_LIMIT_EXCEEDED",
      details: {
        appId: ids.appId,
        limit: 200,
        runningExperiments: 201,
        recommendedAction: "READ_PER_ENVIRONMENT",
      },
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses before planning when the Environment count alone is over budget", async () => {
    const repo = repository();
    // 200 bulk Environments on top of the three the fixture seeds: 203 > 200.
    await seedEnvironments(repo, 200);
    const read = vi.fn<AnalysisResultsReader["read"]>();
    const { spied, listRunningExperiments } = spyOnPlanningReads(repo);
    const app = harness({ read }, authFor(ids.appId, USER_ID), spied);

    const response = await app.request(`/apps/${ids.appId}/attention-rollup`, {
      headers: { authorization: "Bearer valid" },
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "ATTENTION_FANOUT_LIMIT_EXCEEDED",
      details: {
        appId: ids.appId,
        limit: 200,
        // Planning never ran, so there is no honest running-Experiment count.
        runningExperiments: null,
        recommendedAction: "READ_PER_ENVIRONMENT",
      },
    });
    expect(read).not.toHaveBeenCalled();
    // The point of this budget is that it fires BEFORE the per-Environment D1
    // fan-out it exists to prevent; observing Analysis reads alone cannot tell
    // the difference between refusing early and refusing after 203 D1 reads.
    expect(listRunningExperiments).not.toHaveBeenCalled();
  });

  it("bounds how many Analysis reads are in flight at once", async () => {
    const repo = repository();
    await seedRunningExperiments(repo, QA_ENVIRONMENT_ID, 40);
    let inFlight = 0;
    let peak = 0;
    const analysisResults: AnalysisResultsReader = {
      async read() {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return statsOutput();
      },
    };
    const app = harness(analysisResults, authFor(ids.appId, USER_ID));

    const response = await app.request(`/apps/${ids.appId}/attention-rollup`, {
      headers: { authorization: "Bearer valid" },
    });

    expect(response.status).toBe(200);
    // Pinned exactly, in both directions: asserting only
    // `peak <= ANALYSIS_READ_CONCURRENCY` passes vacuously for any raised
    // constant, and a pool that never fills would satisfy an upper bound alone.
    expect(ANALYSIS_READ_CONCURRENCY).toBe(8);
    expect(peak).toBe(ANALYSIS_READ_CONCURRENCY);
  });
});
