import { appScope } from "@splitch/db";
import { DELEGATED_IDENTITY_HEADER } from "@splitch/worker-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  type AnalysisResultsReader,
  createAnalysisResultsReader,
} from "./attention-analysis-reader";
import {
  ATTENTION_TEST_TIMEOUT,
  authFor,
  type EnvironmentAttentionItem,
  harness,
  OTHER_APP_ID,
  QA_ENVIRONMENT_ID,
  repository,
  setupAttentionRollupFixture,
  statsOutput,
  USER_ID,
} from "./attention-rollup-fixture";
import { seedOtherOrganization } from "./attention-rollup-seeds";
import { ids, NOW } from "./config-store-fixture-data";

setupAttentionRollupFixture();

describe("attention rollup Organization isolation", { timeout: ATTENTION_TEST_TIMEOUT }, () => {
  it("never surfaces another Organization's Environments or reads its analysis", async () => {
    // A second Organization with its own Organization, App, Environment and running
    // Experiment, seeded with attention so any leak flips a flag rather than
    // matching the caller's own data.
    const other = await seedOtherOrganization(repository());
    const scopes: Array<{ appId: string; environmentId: string }> = [];
    const analysisResults: AnalysisResultsReader = {
      async read(scope) {
        scopes.push(scope);
        return scope.appId === other.appId
          ? statsOutput({ srm: true, guardrail: true })
          : statsOutput();
      },
    };
    const app = harness(analysisResults, authFor(ids.appId, USER_ID));

    const own = await app.request(`/apps/${ids.appId}/attention-rollup`, {
      headers: { authorization: "Bearer valid" },
    });
    const body = (await own.json()) as { appId: string; items: EnvironmentAttentionItem[] };

    expect(own.status).toBe(200);
    expect(body.appId).toBe(ids.appId);
    expect(body.items.map((item) => item.environmentId).sort()).toEqual(
      [ids.devEnvironmentId, ids.environmentId, QA_ENVIRONMENT_ID].sort(),
    );
    expect(body.items.every((item) => item.state !== "attention")).toBe(true);
    // Non-vacuous: reads did happen, and every one stayed inside the caller's App.
    expect(scopes).toHaveLength(2);
    expect(scopes.every((scope) => scope.appId === ids.appId)).toBe(true);
    expect(scopes.some((scope) => scope.environmentId === other.environmentId)).toBe(false);

    // The same live credential must not reach the other Organization's App by asking.
    const crossOrganization = await app.request(`/apps/${other.appId}/attention-rollup`, {
      headers: { authorization: "Bearer valid" },
    });

    expect(crossOrganization.status).toBe(403);
    expect(scopes.some((scope) => scope.appId === other.appId)).toBe(false);
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

  // Layer consistency with Analysis Worker results.ts: a Run-provenance mismatch
  // is permanent. Emitting SERVICE_UNAVAILABLE would invite polling through a
  // fault that waiting never clears (ADR-0036).
  it("refuses a Run-provenance mismatch as non-retryable INTERNAL_SERVER_ERROR", async () => {
    const app = harness(
      createAnalysisResultsReader({
        fetch: async () =>
          Response.json({
            state: "ready",
            run_id: "run_some_other_run",
            control_variant: "control",
            stats: statsOutput(),
          }),
      }),
      authFor(ids.appId, USER_ID),
    );

    const response = await app.request(`/apps/${ids.appId}/attention-rollup`, {
      headers: { authorization: "Bearer valid" },
    });
    const body = (await response.json()) as { code: string; details: unknown };

    expect(response.status).toBe(500);
    expect(body.code).toBe("INTERNAL_SERVER_ERROR");
    expect(body.details).not.toHaveProperty("retryAfterMs");
    expect(response.headers.get("retry-after")).toBeNull();
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
    const repo = repository();
    await repo.identity.createAppMembership(appScope(ids.appId), {
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

  // The mirror of the case above: Organization membership alone must not carry a
  // caller into an App they were never added to.
  it("rejects an Organization member with no App membership before analysis reads", async () => {
    const repo = repository();
    await repo.identity.createOrgMembership({
      orgId: ids.orgId,
      userId: "user_org_only",
      role: "member",
      createdAt: NOW,
    });
    const read = vi.fn<AnalysisResultsReader["read"]>();
    const app = harness({ read }, authFor(ids.appId, "user_org_only"));

    const response = await app.request(`/apps/${ids.appId}/attention-rollup`, {
      headers: { authorization: "Bearer valid" },
    });

    expect(response.status).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });
});

describe("Analysis results boundary", { timeout: ATTENTION_TEST_TIMEOUT }, () => {
  it("uses a least-privilege scoped identity over the service binding", async () => {
    const fetcher = {
      fetch: vi.fn(async (_request: Request) =>
        Response.json({
          state: "ready",
          run_id: ids.liveRunId,
          control_variant: "control",
          stats: statsOutput({ srm: true }),
        }),
      ),
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
      `https://delegated.splitch.internal/apps/${ids.appId}/envs/${ids.environmentId}/experiments/${ids.experimentId}/results`,
    );
    expect(request?.method).toBe("POST");
    await expect(request?.clone().json()).resolves.toEqual({ runId: ids.liveRunId });
    expect(request?.headers.get("authorization")).toBeNull();
    expect(request?.headers.get("x-splitch-panel-session")).toBeNull();
    expect(JSON.parse(request?.headers.get(DELEGATED_IDENTITY_HEADER) ?? "{}")).toEqual({
      operation: "experiment_results_post",
      actorId: USER_ID,
      orgId: null,
      appId: ids.appId,
      environmentId: ids.environmentId,
    });
  });

  it.each(["EXPERIMENT_NOT_FOUND", "RUN_NOT_FOUND"] as const)(
    "maps a typed %s result to null without fabricating attention",
    async (code) => {
      const reader = createAnalysisResultsReader({
        fetch: async () =>
          Response.json(
            { code, message: "analysis result not found", details: {} },
            { status: 404 },
          ),
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
    },
  );

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
