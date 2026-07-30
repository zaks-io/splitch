import {
  parsePanelExperimentResultsOutput,
  SCOPED_SERVICE_IDENTITY_HEADER,
} from "@splitch/control-plane-sdk/panel-experiments";
import type { Repository } from "@splitch/db";
import { describe, expect, it, vi } from "vitest";
import { panelExperimentResults } from "./panel-experiments";
import { experimentRow, runRow, statsOutput } from "./panel-experiments-test-fixtures";

const APP_ID = "app_panel_results";
const ENVIRONMENT_ID = "env_panel_results";
const ACTOR_ID = "user_panel_results";
const EXPERIMENT_ID = "exp_panel_results";
const LATEST_RUN_ID = "run_panel_results_2";
const PREVIOUS_RUN_ID = "run_panel_results_1";

const ids = {
  appId: APP_ID,
  environmentId: ENVIRONMENT_ID,
  experimentId: EXPERIMENT_ID,
  latestRunId: LATEST_RUN_ID,
  previousRunId: PREVIOUS_RUN_ID,
  actorId: ACTOR_ID,
  flagId: "flag_panel_results",
  orgId: "org_panel_results",
};

function repository(overrides: Record<string, unknown> = {}): Repository {
  const {
    orgMembership = { role: "owner" },
    appMembership = { role: "owner" },
    environment = { id: ENVIRONMENT_ID },
    runs = [runRow(ids, 1), runRow(ids, 2)],
    experiment = experimentRow(ids),
  } = overrides;
  return {
    identity: {
      getApp: vi.fn(async () => ({ id: APP_ID, organizationId: ids.orgId })),
      getOrgMembership: vi.fn(async () => orgMembership),
      getAppMembership: vi.fn(async () => appMembership),
      getEnvironment: vi.fn(async () => environment),
    },
    flags: { flags: { findMany: vi.fn(async () => [{ id: ids.flagId, name: "Checkout Flag" }]) } },
    experiments: {
      getExperiment: vi.fn(async () => experiment),
      listRunsForExperiment: vi.fn(async () => runs),
    },
  } as unknown as Repository;
}

function analysisReturning(stats: unknown) {
  return vi.fn(async (_request: Request) => Response.json(stats));
}

async function results(
  analysis: ReturnType<typeof analysisReturning>,
  input: { runId?: string } = {},
  repo: Repository = repository(),
) {
  return panelExperimentResults(
    { repo, analysis: { fetch: analysis } as unknown as Fetcher },
    {
      actorId: ACTOR_ID,
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      experimentId: EXPERIMENT_ID,
      ...input,
    },
  );
}

describe("panel Experiment Results read", () => {
  it("reads the latest Run when no Run is pinned, and never pools Runs", async () => {
    const analysis = analysisReturning(statsOutput());
    const response = await results(analysis);

    expect(response.status).toBe(200);
    expect(analysis).toHaveBeenCalledTimes(1);
    const request = analysis.mock.calls[0]?.[0];
    expect(await request?.clone().json()).toEqual({ runId: LATEST_RUN_ID });
    expect(JSON.parse(request?.headers.get(SCOPED_SERVICE_IDENTITY_HEADER) ?? "{}")).toMatchObject({
      operation: "experiment_results_post",
      actorId: ACTOR_ID,
      runId: LATEST_RUN_ID,
    });
    expect(await response.json()).toMatchObject({ runId: LATEST_RUN_ID, runNumber: 2 });
  });

  it("reads exactly the pinned Run when one is requested", async () => {
    const analysis = analysisReturning(statsOutput());
    const response = await results(analysis, { runId: PREVIOUS_RUN_ID });

    expect(await analysis.mock.calls[0]?.[0]?.clone().json()).toEqual({ runId: PREVIOUS_RUN_ID });
    expect(await response.json()).toMatchObject({
      runId: PREVIOUS_RUN_ID,
      runNumber: 1,
      runStatus: "ended",
    });
  });

  it("refuses an unknown Run instead of falling back to another Run's numbers", async () => {
    const analysis = analysisReturning(statsOutput());
    const response = await results(analysis, { runId: "run_not_mine" });

    expect(response.status).toBe(404);
    expect(analysis).not.toHaveBeenCalled();
  });

  it("refuses stale App membership before any analysis read", async () => {
    const analysis = analysisReturning(statsOutput());
    const response = await results(analysis, {}, repository({ appMembership: null }));

    expect(response.status).toBe(403);
    expect(analysis).not.toHaveBeenCalled();
  });

  it("refuses an Experiment outside the requested Environment", async () => {
    const analysis = analysisReturning(statsOutput());
    const response = await results(analysis, {}, repository({ experiment: null }));

    expect(response.status).toBe(404);
    expect(analysis).not.toHaveBeenCalled();
  });

  it("emits a payload the Panel contract accepts", async () => {
    const response = await results(analysisReturning(statsOutput()));
    expect(parsePanelExperimentResultsOutput(await response.json()).success).toBe(true);
  });

  it("evaluates the ship gate here and blocks with the failing check named", async () => {
    const response = await results(
      analysisReturning(
        statsOutput({
          srm: {
            srm_p_value: 0.0000002,
            srm_is_mismatch: true,
            observed_counts: { control: 950, treatment: 50 },
            expected_counts: { control: 500, treatment: 500 },
            activated_srm_p_value: null,
            activated_srm_mismatch: null,
          },
        }),
      ),
    );
    const body = (await response.json()) as {
      gate: { shipAllowed: boolean; blockedBy: string[]; enforcedBy: string };
      srm: { exposure: { tier: string } };
      stats: { arm_results: unknown[] };
    };

    expect(body.gate.shipAllowed).toBe(false);
    expect(body.gate.blockedBy).toContain("exposure_srm");
    expect(body.gate.enforcedBy).toBe("control-plane-api");
    expect(body.srm.exposure.tier).toBe("confirmed");
    // The refusal never withholds the numbers it refuses to decide on.
    expect(body.stats.arm_results).toHaveLength(1);
  });

  it("allows the ship decision on a clean, powered, decision-valid Run", async () => {
    const response = await results(analysisReturning(statsOutput()));
    const body = (await response.json()) as { gate: { shipAllowed: boolean; blockedBy: string[] } };

    expect(body.gate.shipAllowed).toBe(true);
    expect(body.gate.blockedBy).toEqual([]);
  });

  it("blocks an underpowered Run and still returns every arm result", async () => {
    const base = statsOutput();
    const response = await results(
      analysisReturning(
        statsOutput({
          arm_results: [{ ...base.arm_results[0], status: "insufficient_n" }],
        }),
      ),
    );
    const body = (await response.json()) as {
      gate: { blockedBy: string[]; checks: { id: string; detail: string }[] };
      stats: { arm_results: { point_estimate: number }[] };
    };

    expect(body.gate.blockedBy).toEqual(["underpowered"]);
    expect(body.gate.checks.find((check) => check.id === "underpowered")?.detail).toContain(
      "conversion / treatment",
    );
    expect(body.stats.arm_results[0]?.point_estimate).toBe(0.8);
  });
});
