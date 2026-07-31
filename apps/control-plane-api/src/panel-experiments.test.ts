import { SCOPED_SERVICE_IDENTITY_HEADER } from "@splitch/control-plane-sdk/panel-experiments";
import type { StatsOutput } from "@splitch/contracts";
import type { Repository } from "@splitch/db";
import { describe, expect, it, vi } from "vitest";
import { panelExperimentDetail, panelExperimentsList } from "./panel-experiments";
import {
  analysisEnvelope,
  experimentRow,
  type PanelExperimentIds,
  runRow,
  statsOutput,
} from "./panel-experiments-test-fixtures";

const APP_ID = "app_panel_list";
const ENVIRONMENT_ID = "env_panel_list";
const ACTOR_ID = "user_panel_list";
const EXPERIMENT_ID = "exp_panel_list";
const RUN_ID = "run_panel_list";

const ids: PanelExperimentIds = {
  appId: APP_ID,
  environmentId: ENVIRONMENT_ID,
  experimentId: EXPERIMENT_ID,
  latestRunId: RUN_ID,
  previousRunId: "run_panel_previous",
  actorId: ACTOR_ID,
  flagId: "flag_panel_list",
  orgId: "org_panel_list",
};

describe("panel Experiments composite read", () => {
  it("rechecks live scope and requests health for the exact live Run", async () => {
    const analysis = vi.fn(async (_request: Request) =>
      Response.json(analysisEnvelope(RUN_ID, allHealthFlagsFiring())),
    );
    const response = await panelExperimentsList(
      { repo: repository(), analysis: { fetch: analysis } as unknown as Fetcher },
      { actorId: ACTOR_ID, appId: APP_ID, environmentId: ENVIRONMENT_ID },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      items: [
        {
          id: EXPERIMENT_ID,
          flag: { id: "flag_panel_list", name: "Checkout Flag" },
          liveRunId: RUN_ID,
          health: {
            significanceReached: true,
            srmFiring: true,
            guardrailBreached: true,
          },
        },
      ],
    });
    const request = analysis.mock.calls[0]?.[0];
    expect(await request?.clone().json()).toEqual({ runId: RUN_ID });
    expect(request?.headers.get("authorization")).toBeNull();
    expect(request?.headers.get("x-splitch-panel-session")).toBeNull();
    expect(JSON.parse(request?.headers.get(SCOPED_SERVICE_IDENTITY_HEADER) ?? "{}")).toEqual({
      operation: "experiment_results_post",
      actorId: ACTOR_ID,
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      experimentId: EXPERIMENT_ID,
      runId: RUN_ID,
    });
  });

  /**
   * List health and the ship gate read the same decision family. If health only
   * looked at `arm_results`, a Run whose decision lives in a Primary Dimension
   * slice would render "Collecting data" while the gate was ready to ship it.
   */
  it.each([
    ["primary", true],
    ["secondary", false],
  ] as const)("reads a significant %s Dimension slice as reached=%s", async (cls, reached) => {
    const analysis = vi.fn(async (_request: Request) =>
      Response.json(analysisEnvelope(RUN_ID, sliceOnlySignificance(cls))),
    );

    const response = await panelExperimentsList(
      { repo: repository(), analysis: { fetch: analysis } as unknown as Fetcher },
      { actorId: ACTOR_ID, appId: APP_ID, environmentId: ENVIRONMENT_ID },
    );

    expect(await response.json()).toMatchObject({
      items: [{ health: { significanceReached: reached } }],
    });
  });

  it("reads a Run with no Analysis rows yet as collecting, not as a failed list", async () => {
    // A Run seconds after Start has nothing in Analysis, which answers
    // RUN_NOT_FOUND. Propagating that would 500 the whole Experiment list for
    // every Environment that just Started a Run.
    const analysis = vi.fn(async (_request: Request) =>
      Response.json(
        { code: "RUN_NOT_FOUND", message: "no Run rows", details: {} },
        { status: 404 },
      ),
    );

    const response = await panelExperimentsList(
      { repo: repository(), analysis: { fetch: analysis } as unknown as Fetcher },
      { actorId: ACTOR_ID, appId: APP_ID, environmentId: ENVIRONMENT_ID },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      items: [
        { health: { significanceReached: false, srmFiring: false, guardrailBreached: false } },
      ],
    });
  });

  it("still propagates an unreadable Analysis result rather than calling it collecting", async () => {
    const analysis = vi.fn(async (_request: Request) =>
      Response.json(
        { code: "INTERNAL_SERVER_ERROR", message: "provenance mismatch", details: {} },
        { status: 500 },
      ),
    );

    await expect(
      panelExperimentsList(
        { repo: repository(), analysis: { fetch: analysis } as unknown as Fetcher },
        { actorId: ACTOR_ID, appId: APP_ID, environmentId: ENVIRONMENT_ID },
      ),
    ).rejects.toThrow();
  });

  it("refuses stale App membership before any downstream read", async () => {
    const analysis = vi.fn();
    const repo = repository({ appMembership: null });
    const response = await panelExperimentsList(
      { repo, analysis: { fetch: analysis } as unknown as Fetcher },
      { actorId: ACTOR_ID, appId: APP_ID, environmentId: ENVIRONMENT_ID },
    );

    expect(response.status).toBe(403);
    expect(analysis).not.toHaveBeenCalled();
  });

  it("refuses stale Organization membership before any downstream read", async () => {
    const analysis = vi.fn();
    const repo = repository({ orgMembership: null });
    const response = await panelExperimentsList(
      { repo, analysis: { fetch: analysis } as unknown as Fetcher },
      { actorId: ACTOR_ID, appId: APP_ID, environmentId: ENVIRONMENT_ID },
    );

    expect(response.status).toBe(403);
    expect(analysis).not.toHaveBeenCalled();
  });

  it("refuses an Environment outside the requested App before listing", async () => {
    const analysis = vi.fn();
    const repo = repository({ environment: null });
    const response = await panelExperimentsList(
      { repo, analysis: { fetch: analysis } as unknown as Fetcher },
      { actorId: ACTOR_ID, appId: APP_ID, environmentId: "env_other" },
    );

    expect(response.status).toBe(404);
    expect(analysis).not.toHaveBeenCalled();
  });

  it("returns newest-first frozen Run snapshots and operator reasons", async () => {
    const response = await panelExperimentDetail(
      { repo: repository() },
      {
        actorId: ACTOR_ID,
        appId: APP_ID,
        environmentId: ENVIRONMENT_ID,
        experimentId: EXPERIMENT_ID,
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      experiment: { id: EXPERIMENT_ID, status: "running", liveRunId: RUN_ID },
      flag: { id: "flag_panel_list", name: "Checkout Flag" },
      runs: [
        {
          id: RUN_ID,
          runNumber: 2,
          allocation: { control: 70, treatment: 30 },
          controlVariantId: "variant_control",
          variantsJson: JSON.stringify([
            { id: "variant_control", name: "control", value: false },
            { id: "variant_treatment", name: "treatment", value: true },
          ]),
          startReason: "Increase treatment traffic",
        },
        { id: "run_panel_previous", runNumber: 1 },
      ],
    });
  });

  it("does not return a same-scope Run list for a missing Experiment", async () => {
    const repo = repository();
    vi.mocked(repo.experiments.getExperiment).mockResolvedValue(null);

    const response = await panelExperimentDetail(
      { repo },
      {
        actorId: ACTOR_ID,
        appId: APP_ID,
        environmentId: ENVIRONMENT_ID,
        experimentId: "experiment_missing",
      },
    );

    expect(response.status).toBe(404);
  });
});

function repository(
  overrides: {
    appMembership?: object | null;
    environment?: object | null;
    orgMembership?: object | null;
  } = {},
): Repository {
  const appMembership = Object.hasOwn(overrides, "appMembership")
    ? overrides.appMembership
    : { role: "member" };
  const environment = Object.hasOwn(overrides, "environment")
    ? overrides.environment
    : { id: ENVIRONMENT_ID, appId: APP_ID };
  const orgMembership = Object.hasOwn(overrides, "orgMembership")
    ? overrides.orgMembership
    : { role: "member" };
  return {
    identity: {
      getApp: vi.fn(async () => ({ id: APP_ID, organizationId: "org_panel_list" })),
      getOrgMembership: vi.fn(async () => orgMembership),
      getAppMembership: vi.fn(async () => appMembership),
      getEnvironment: vi.fn(async () => environment),
    },
    flags: {
      flags: { findMany: vi.fn(async () => [{ id: "flag_panel_list", name: "Checkout Flag" }]) },
      listVariants: vi.fn(async () => [
        { id: "variant_control", name: "control" },
        { id: "variant_treatment", name: "treatment" },
      ]),
      getFlagConfig: vi.fn(async () => ({
        availableVariantNames: JSON.stringify(["control", "treatment"]),
      })),
    },
    experiments: {
      metrics: {
        findMany: vi.fn(async () => [{ id: "metric_signup", name: "Signup" }]),
      },
      listExperiments: vi.fn(async () => [experimentRow(ids)]),
      getExperiment: vi.fn(async () => experimentRow(ids)),
      listRunsForExperiment: vi.fn(async () => [runRow(ids, 1), runRow(ids, 2)]),
    },
  } as unknown as Repository;
}

/**
 * Every health flag firing at once, so a test that asserts all three cannot pass
 * on a handler that reads only one of them. Only the branches that differ from
 * the clean `statsOutput` fixture are spelled out — a hand-rolled copy of the
 * whole envelope drifts from the shared one and stops proving anything.
 */
function allHealthFlagsFiring(): StatsOutput {
  return statsOutput({
    srm: {
      srm_p_value: 0.001,
      srm_is_mismatch: true,
      observed_counts: { control: 100, treatment: 10 },
      expected_counts: { control: 55, treatment: 55 },
      activated_srm_p_value: null,
      activated_srm_mismatch: null,
    },
    guardrail_results: [
      {
        metric_id: "latency",
        variant: "treatment",
        ci_lower: -20,
        threshold: -10,
        is_breached: true,
        in_bh_family: false,
        exploratory: false,
        decision_valid: true,
        breach_reason: "threshold crossed",
      },
    ],
  });
}

/** Nothing significant at the top level; the only significant arm is in a slice. */
function sliceOnlySignificance(dimensionClass: "primary" | "secondary"): StatsOutput {
  const base = statsOutput();
  const [arm] = base.arm_results;
  return {
    ...base,
    arm_results: [{ ...arm, is_significant: false, p_value: 0.4 }],
    dimension_results: [
      {
        dimension_id: "country",
        dimension_value: "US",
        class: dimensionClass,
        arm_results: [arm],
        sample_size_n: 100,
        low_n_warning: false,
        in_bh_family: dimensionClass === "primary",
        exploratory: dimensionClass !== "primary",
        decision_valid: dimensionClass === "primary",
      },
    ],
  };
}
