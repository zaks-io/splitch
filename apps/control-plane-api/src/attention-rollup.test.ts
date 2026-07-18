import type { StatsOutput } from "@splitch/contracts";
import { SCOPED_SERVICE_IDENTITY_HEADER } from "@splitch/control-plane-sdk/panel-experiments";
import { appScope, createRepository, envScope } from "@splitch/db";
import type { AuthResolver, Principal, RateLimiter } from "@splitch/worker-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { type AnalysisResultsReader, createAnalysisResultsReader } from "./attention-rollup";
import { ids, NOW, seedConfigGraph } from "./config-store-fixture-data";
import { type LocalBindings, makeLocalBindings } from "./test-fixtures";

const USER_ID = "user_attention";
const OTHER_APP_ID = "app_other_attention";
const DEV_EXPERIMENT_ID = "exp_attention_dev";
const QA_ENVIRONMENT_ID = "env_qa";
const allowLimiter: RateLimiter = () => ({ limited: false });

let bindings: LocalBindings;

beforeEach(async () => {
  bindings = await makeLocalBindings();
  await seedConfigGraph(bindings.d1);
  const repo = createRepository(bindings.d1);
  await repo.identity.createAppMembership({
    appId: ids.appId,
    userId: USER_ID,
    role: "member",
    createdAt: NOW,
  });
  await repo.identity.createOrgMembership({
    orgId: ids.orgId,
    userId: USER_ID,
    role: "member",
    createdAt: NOW,
  });
  await repo.identity.environments.insert(appScope(ids.appId), {
    id: QA_ENVIRONMENT_ID,
    appId: ids.appId,
    key: "qa",
    name: "QA",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repo.experiments.experiments.insert(envScope(ids.appId, ids.devEnvironmentId), {
    id: DEV_EXPERIMENT_ID,
    appId: ids.appId,
    environmentId: ids.devEnvironmentId,
    key: "attention-dev",
    flagId: ids.flagId,
    name: "Dev attention",
    status: "running",
    targetingKeyField: "userId",
    targetingKeyType: "user",
    metrics: "[]",
    guardrailMetrics: "[]",
    dimensions: "[]",
    liveRunId: "run_attention_dev",
    createdAt: NOW,
    updatedAt: NOW,
  });
});

afterEach(async () => bindings.dispose());

describe("GET /apps/:appId/attention-rollup", () => {
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

  it("fails loud when the analysis boundary is unavailable", async () => {
    const app = harness(
      createAnalysisResultsReader({ fetch: async () => new Response(null, { status: 503 }) }),
      authFor(ids.appId, USER_ID),
    );

    const response = await app.request(`/apps/${ids.appId}/attention-rollup`, {
      headers: { authorization: "Bearer valid" },
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      details: { retryAfterMs: 30_000 },
    });
  });

  it("rejects cross-App scope and stale membership before analysis reads", async () => {
    const read = vi.fn<AnalysisResultsReader["read"]>();
    const reader = { read };
    const crossApp = harness(reader, authFor(OTHER_APP_ID, USER_ID));
    const staleMembership = harness(reader, authFor(ids.appId, "user_not_a_member"));

    const crossResponse = await crossApp.request(`/apps/${ids.appId}/attention-rollup`, {
      headers: { authorization: "Bearer valid" },
    });
    const staleResponse = await staleMembership.request(`/apps/${ids.appId}/attention-rollup`, {
      headers: { authorization: "Bearer valid" },
    });

    expect(crossResponse.status).toBe(403);
    expect(staleResponse.status).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects stale Organization membership before analysis reads", async () => {
    const repo = createRepository(bindings.d1);
    await repo.identity.createAppMembership({
      appId: ids.appId,
      userId: "user_not_in_org",
      role: "member",
      createdAt: NOW,
    });
    const read = vi.fn<AnalysisResultsReader["read"]>();
    const app = harness({ read }, authFor(ids.appId, "user_not_in_org"));

    const response = await app.request(`/apps/${ids.appId}/attention-rollup`, {
      headers: { authorization: "Bearer valid" },
    });

    expect(response.status).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });
});

describe("Analysis results boundary", () => {
  it("uses a least-privilege scoped identity over the service binding", async () => {
    const fetcher = {
      fetch: vi.fn(async (_request: Request) => Response.json(statsOutput({ srm: true }))),
    };
    const reader = createAnalysisResultsReader(fetcher);

    await expect(
      reader.read(
        {
          appId: ids.appId,
          environmentId: ids.environmentId,
          experimentId: ids.experimentId,
          runId: ids.liveRunId,
        },
        USER_ID,
      ),
    ).resolves.toMatchObject({ srm: { srm_is_mismatch: true } });

    const request = fetcher.fetch.mock.calls[0]?.[0];
    expect(request?.url).toBe(
      `https://analysis.internal/apps/${ids.appId}/envs/${ids.environmentId}/experiments/${ids.experimentId}/results`,
    );
    expect(request?.method).toBe("POST");
    await expect(request?.clone().json()).resolves.toEqual({ runId: ids.liveRunId });
    expect(request?.headers.get("authorization")).toBeNull();
    expect(request?.headers.get("x-splitch-panel-session")).toBeNull();
    expect(JSON.parse(request?.headers.get(SCOPED_SERVICE_IDENTITY_HEADER) ?? "{}")).toEqual({
      operation: "experiment_results_post",
      actorId: USER_ID,
      appId: ids.appId,
      environmentId: ids.environmentId,
      experimentId: ids.experimentId,
      runId: ids.liveRunId,
    });
  });

  it.each([
    "EXPERIMENT_NOT_FOUND",
    "RUN_NOT_FOUND",
  ] as const)("maps a typed %s result to null without fabricating attention", async (code) => {
    const reader = createAnalysisResultsReader({
      fetch: async () =>
        Response.json({ code, message: "analysis result not found", details: {} }, { status: 404 }),
    });

    await expect(
      reader.read(
        {
          appId: ids.appId,
          environmentId: ids.environmentId,
          experimentId: ids.experimentId,
          runId: ids.liveRunId,
        },
        USER_ID,
      ),
    ).resolves.toBeNull();
  });

  it("fails loud for an untyped upstream 404", async () => {
    const reader = createAnalysisResultsReader({
      fetch: async () => new Response(null, { status: 404 }),
    });

    await expect(
      reader.read(
        {
          appId: ids.appId,
          environmentId: ids.environmentId,
          experimentId: ids.experimentId,
          runId: ids.liveRunId,
        },
        USER_ID,
      ),
    ).rejects.toThrow("analysis results unavailable");
  });
});

function harness(analysisResults: AnalysisResultsReader, authResolver: AuthResolver) {
  return createApp({
    authResolver,
    rateLimiter: allowLimiter,
    repo: createRepository(bindings.d1),
    analysisResults,
  });
}

function authFor(appId: string, userId: string): AuthResolver {
  return async () => ({ ok: true, principal: principal(appId, userId) });
}

function principal(appId: string, userId: string): Principal {
  return {
    kind: "control-plane-token",
    id: userId,
    scopes: [`app:${appId}:member`],
    orgId: null,
    appId,
    environmentId: null,
  };
}

function statsOutput(input: { srm?: boolean; guardrail?: boolean } = {}): StatsOutput {
  return {
    arm_results: [],
    srm: {
      srm_p_value: input.srm ? 0.0001 : 0.5,
      srm_is_mismatch: input.srm ?? false,
      observed_counts: { control: 10, treatment: 10 },
      expected_counts: { control: 10, treatment: 10 },
      activated_srm_p_value: null,
      activated_srm_mismatch: null,
    },
    guardrail_results: input.guardrail
      ? [
          {
            metric_id: "metric_guardrail",
            variant: "treatment",
            ci_lower: -0.2,
            threshold: -0.1,
            is_breached: true,
            in_bh_family: false,
            exploratory: false,
            decision_valid: true,
            breach_reason: "lower confidence bound crossed threshold",
          },
        ]
      : [],
    health: {
      multiple_rate: 0,
      multiple_count: 0,
      activation_rates: null,
      activation_balance_p_value: null,
      activation_balance_mismatch: null,
      exposure_counts: { control: 10, treatment: 10 },
      deduped_counts: { control: 10, treatment: 10 },
      low_n_warning: false,
    },
  };
}
