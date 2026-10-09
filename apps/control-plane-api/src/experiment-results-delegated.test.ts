import { describe, expect, it, vi } from "vitest";
import {
  binding,
  deps,
  membershipWideAdminPrincipal,
  NO_RUN_BODY,
  OTHER_TENANT_RESULTS_PATH,
  RESULTS_APP_ID,
  RESULTS_PATH,
  stubRun,
} from "./delegated-routes-test-fixtures";
import { analysisEnvelope, statsOutput } from "./panel-experiments-test-fixtures";
import { makeTestApp as createApp } from "./test-app-fixture";

describe("experiment results Experiment vs Run resolution (SPL-305)", () => {
  it("returns typed no_run for a draft Experiment without calling Analysis", async () => {
    const forwarded: Request[] = [];
    const analysis = binding(forwarded, Response.json({ ok: false }));
    const response = await createApp(
      deps({
        bindings: { "analysis-api": analysis },
        experiments: {
          getExperiment: vi.fn(async () => ({ id: "exp_1", status: "draft" })),
          listRunsForExperiment: vi.fn(async () => []),
        },
      }),
    ).request(RESULTS_PATH, { headers: { authorization: "Bearer stub" } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(NO_RUN_BODY);
    expect(forwarded).toHaveLength(0);
  });

  it("returns 200 no_run for a draft even when Analysis binding is unbound", async () => {
    const response = await createApp(
      deps({
        experiments: {
          getExperiment: vi.fn(async () => ({ id: "exp_1", status: "draft" })),
          listRunsForExperiment: vi.fn(async () => []),
        },
      }),
    ).request(RESULTS_PATH, { headers: { authorization: "Bearer stub" } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(NO_RUN_BODY);
  });

  it("returns EXPERIMENT_NOT_FOUND for a genuinely nonexistent id without calling Analysis", async () => {
    const forwarded: Request[] = [];
    const analysis = binding(forwarded, Response.json({ ok: false }));
    const response = await createApp(
      deps({
        bindings: { "analysis-api": analysis },
        experiments: {
          getExperiment: vi.fn(async () => null),
          listRunsForExperiment: vi.fn(async () => {
            throw new Error("must not list Runs when Experiment is missing");
          }),
        },
      }),
    ).request(RESULTS_PATH, { headers: { authorization: "Bearer stub" } });

    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe("EXPERIMENT_NOT_FOUND");
    expect(forwarded).toHaveLength(0);
  });

  it("returns EXPERIMENT_NOT_FOUND for a missing id even when Analysis binding is unbound", async () => {
    const response = await createApp(
      deps({
        experiments: {
          getExperiment: vi.fn(async () => null),
          listRunsForExperiment: vi.fn(async () => {
            throw new Error("must not list Runs when Experiment is missing");
          }),
        },
      }),
    ).request(RESULTS_PATH, { headers: { authorization: "Bearer stub" } });

    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe("EXPERIMENT_NOT_FOUND");
  });

  it("returns EXPERIMENT_NOT_FOUND for another tenant's Experiment id (existence is not leaked)", async () => {
    const tenantA = {
      appId: "app_1",
      environmentId: "env_1",
      experimentId: "exp_tenant_a",
    };
    const tenantB = {
      appId: "app_2",
      environmentId: "env_2",
      experimentId: "exp_tenant_b",
    };
    const forwarded: Request[] = [];
    const analysis = binding(forwarded, Response.json({ ok: false }));
    const getExperiment = vi.fn(async (scope: { appId: string }, experimentId: string) => {
      if (scope.appId === tenantA.appId && experimentId === tenantA.experimentId) {
        return { id: tenantA.experimentId, status: "draft" };
      }
      if (scope.appId === tenantB.appId && experimentId === tenantB.experimentId) {
        return { id: tenantB.experimentId, status: "draft" };
      }
      return null;
    });

    const response = await createApp(
      deps({
        bindings: { "analysis-api": analysis },
        experiments: {
          getExperiment,
          listRunsForExperiment: vi.fn(async () => []),
        },
      }),
    ).request(OTHER_TENANT_RESULTS_PATH, { headers: { authorization: "Bearer stub" } });

    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe("EXPERIMENT_NOT_FOUND");
    expect(forwarded).toHaveLength(0);
    expect(getExperiment).toHaveBeenCalledWith(
      expect.objectContaining({ appId: tenantA.appId, environmentId: tenantA.environmentId }),
      tenantB.experimentId,
    );
  });

  it("pins the latest Run on the hop when the Experiment has Runs and no runId was requested", async () => {
    const forwarded: Request[] = [];
    const analysis = binding(forwarded, Response.json(analysisEnvelope("run_2", statsOutput())));
    const response = await createApp(
      deps({
        bindings: { "analysis-api": analysis },
        experiments: {
          getExperiment: vi.fn(async () => ({ id: "exp_1", status: "running" })),
          listRunsForExperiment: vi.fn(async () => [
            { id: "run_1", runNumber: 1 },
            { id: "run_2", runNumber: 2 },
          ]),
          getRun: vi.fn(async (_scope, runId: string) =>
            runId === "run_2" ? stubRun("run_2", 2) : stubRun("run_1", 1),
          ),
        },
      }),
    ).request(RESULTS_PATH, { headers: { authorization: "Bearer stub" } });

    expect(response.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(new URL(forwarded[0]?.url ?? "").searchParams.get("runId")).toBe("run_2");
    expect(await response.json()).toMatchObject({
      view: "detailed",
      state: "ready",
      run_id: "run_2",
      readiness: expect.any(Object),
    });
  });

  it("honors view=concise on the public results route", async () => {
    const forwarded: Request[] = [];
    const analysis = binding(forwarded, Response.json(analysisEnvelope("run_7", statsOutput())));
    const response = await createApp(deps({ bindings: { "analysis-api": analysis } })).request(
      `${RESULTS_PATH}?runId=run_7&view=concise`,
      { headers: { authorization: "Bearer stub" } },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ view: "concise", state: "ready", run_id: "run_7" });
    expect(body).not.toHaveProperty("stats");
    expect(new URL(forwarded[0]?.url ?? "").searchParams.has("view")).toBe(false);
  });
});

const COMPLETE_EVIDENCE = {
  data_watermark: "2026-09-08T18:00:00.000Z",
  result_token: `sha256:${"a".repeat(64)}`,
} as const;

describe("experiment results concludeExecutable matches runs_conclude guards", () => {
  it("is true for an App admin when evidence and gate are otherwise complete", async () => {
    const analysis = binding(
      [],
      Response.json(analysisEnvelope("run_7", statsOutput(), COMPLETE_EVIDENCE)),
    );
    const response = await createApp(deps({ bindings: { "analysis-api": analysis } })).request(
      RESULTS_PATH,
      { headers: { authorization: "Bearer stub" } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      readiness: { statistical: true, concludeExecutable: true },
      data_watermark: COMPLETE_EVIDENCE.data_watermark,
      result_token: COMPLETE_EVIDENCE.result_token,
    });
  });

  it("is false for a membership-wide-read token even when live role is admin", async () => {
    const analysis = binding(
      [],
      Response.json(analysisEnvelope("run_7", statsOutput(), COMPLETE_EVIDENCE)),
    );
    const response = await createApp(
      deps({
        bindings: { "analysis-api": analysis },
        principal: membershipWideAdminPrincipal(),
      }),
    ).request(RESULTS_PATH, { headers: { authorization: "Bearer stub" } });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      readiness: { concludeExecutable: false },
      data_watermark: COMPLETE_EVIDENCE.data_watermark,
      result_token: COMPLETE_EVIDENCE.result_token,
    });
  });

  it("is false when the principal lacks App admin/owner scopes", async () => {
    const analysis = binding(
      [],
      Response.json(analysisEnvelope("run_7", statsOutput(), COMPLETE_EVIDENCE)),
    );
    const response = await createApp(
      deps({
        bindings: { "analysis-api": analysis },
        principal: {
          scopes: [`app:${RESULTS_APP_ID}:member`],
          appId: RESULTS_APP_ID,
        },
        membershipRole: "admin",
      }),
    ).request(RESULTS_PATH, { headers: { authorization: "Bearer stub" } });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      readiness: { concludeExecutable: false },
      data_watermark: COMPLETE_EVIDENCE.data_watermark,
      result_token: COMPLETE_EVIDENCE.result_token,
    });
  });
});

describe("experiment results Analysis no_run after Run resolution", () => {
  it("fails loud instead of returning START_A_RUN when a Run was already resolved", async () => {
    const analysis = binding(
      [],
      Response.json({ state: "no_run", recommended_action: "START_A_RUN" }),
    );
    const response = await createApp(deps({ bindings: { "analysis-api": analysis } })).request(
      RESULTS_PATH,
      { headers: { authorization: "Bearer stub" } },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });
});
