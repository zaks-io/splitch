import { SCOPED_SERVICE_IDENTITY_HEADER } from "@splitch/control-plane-sdk/panel-experiments";
import type { Repository } from "@splitch/db";
import { describe, expect, it, vi } from "vitest";
import { panelExperimentDetail, panelExperimentsList } from "./panel-experiments";
import { experimentRow, type PanelExperimentIds, runRow } from "./panel-experiments-test-fixtures";

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
    const analysis = vi.fn(async (_request: Request) => Response.json(statsOutput()));
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
    },
    experiments: {
      listExperiments: vi.fn(async () => [experimentRow(ids)]),
      getExperiment: vi.fn(async () => experimentRow(ids)),
      listRunsForExperiment: vi.fn(async () => [runRow(ids, 1), runRow(ids, 2)]),
    },
  } as unknown as Repository;
}

function statsOutput() {
  return {
    arm_results: [
      {
        variant: "treatment",
        metric_id: "conversion",
        sample_size_n: 100,
        point_estimate: 0.8,
        relative_lift_pct: 100,
        ci_lower: 50,
        ci_upper: 150,
        p_value: 0.001,
        is_significant: true,
        in_bh_family: true,
        exploratory: false,
        decision_valid: true,
        status: "ready",
        variance_techniques: {
          winsorized: false,
          winsorize_pct: null,
          winsorize_cap: null,
          cuped_applied: false,
          cuped_method: null,
          cuped_attribute: null,
          cuped_attribute_source: null,
          cuped_coverage_pct: null,
          delta_method: false,
        },
      },
    ],
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
    health: {
      multiple_rate: 0,
      multiple_count: 0,
      activation_rates: null,
      activation_balance_p_value: null,
      activation_balance_mismatch: null,
      exposure_counts: { control: 100, treatment: 10 },
      deduped_counts: { control: 100, treatment: 10 },
      low_n_warning: false,
    },
  };
}
