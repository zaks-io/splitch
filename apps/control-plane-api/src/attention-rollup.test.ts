import { describe, expect, it, vi } from "vitest";
import type { AnalysisResultsReader } from "./attention-analysis-reader";
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
  setupAttentionRollupFixture,
  spyOnPlanningReads,
  statsOutput,
  USER_ID,
} from "./attention-rollup-fixture";
import {
  seedEnvironments,
  seedRunningExperiments,
  seedRunningExperimentWithoutRun,
} from "./attention-rollup-seeds";
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
