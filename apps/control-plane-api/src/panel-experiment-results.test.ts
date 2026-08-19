import {
  type PanelExperimentResultsOutput,
  parsePanelExperimentResultsOutput,
} from "@splitch/control-plane-sdk/panel-experiments";
import type { AnalysisResultsEnvelope, StatsOutput } from "@splitch/contracts";
import type { Repository } from "@splitch/db";
import { DELEGATED_IDENTITY_HEADER } from "@splitch/worker-runtime";
import { describe, expect, it, vi } from "vitest";
import { panelExperimentResults } from "./panel-experiments";
import {
  analysisEnvelope,
  experimentRow,
  runRow,
  statsOutput,
} from "./panel-experiments-test-fixtures";

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

/** Echoes back the Run it was asked for, as the real Analysis Worker does. */
function analysisReturning(
  stats: StatsOutput,
  envelope: Partial<Extract<AnalysisResultsEnvelope, { state: "ready" }>> = {},
) {
  return vi.fn(async (request: Request) => {
    const { runId } = (await request.clone().json()) as { runId: string };
    return Response.json(analysisEnvelope(runId, stats, envelope));
  });
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
    expect(JSON.parse(request?.headers.get(DELEGATED_IDENTITY_HEADER) ?? "{}")).toMatchObject({
      operation: "experiment_results_post",
      actorId: ACTOR_ID,
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
});

describe("panel Experiment Results Control integrity", () => {
  it("names an Analysis Control disagreement without relabelling or hiding the numbers", async () => {
    const analysis = analysisReturning(statsOutput(), { control_variant: "legacy_checkout" });
    const response = await results(analysis, { runId: PREVIOUS_RUN_ID });
    const body = (await response.json()) as PanelExperimentResultsOutput;

    expect(body.state).toBe("ready");
    if (body.state !== "ready") throw new Error("expected ready");
    expect(body.control).toEqual({
      state: "disagreement",
      variantId: "variant_control",
      variant: "control",
      analysisVariant: "legacy_checkout",
    });
    expect(body.gate.blockedBy).toContain("control_identity");
    expect(body.gate.checks.find((check) => check.id === "control_identity")?.title).toContain(
      "disagrees",
    );
    expect(body.stats.arm_results).toHaveLength(1);
  });

  it("carries the server-reported Analysis Control onto an unresolvable Control", async () => {
    // Shaped like SPL-184: a backfilled Control absent from the Run's frozen Variant set.
    const legacy = { ...runRow(ids, 1), controlVariantId: "variant_from_a_later_edit" };
    const response = await results(
      analysisReturning(statsOutput(), { control_variant: "control" }),
      { runId: PREVIOUS_RUN_ID },
      repository({ runs: [legacy, runRow(ids, 2)] }),
    );
    const body = (await response.json()) as PanelExperimentResultsOutput;

    expect(response.status).toBe(200);
    expect(body.state).toBe("ready");
    if (body.state !== "ready") throw new Error("expected ready");
    expect(body.control).toEqual({
      state: "unresolvable",
      variantId: "variant_from_a_later_edit",
      reason: "absent_from_frozen_variant_set",
      frozenVariantNames: ["control", "treatment"],
      analysisVariant: "control",
    });
    expect(body.gate.shipAllowed).toBe(false);
    expect(body.gate.blockedBy).toContain("control_identity");
    // The numbers are still served: rigor is enforced on the decision.
    expect(body.stats.arm_results).toHaveLength(1);
  });
});

describe("panel Experiment Results payload and decision gate", () => {
  it("emits a payload the Panel contract accepts", async () => {
    const response = await results(analysisReturning(statsOutput()));
    expect(parsePanelExperimentResultsOutput(await response.json()).success).toBe(true);
  });

  it("passes through Analysis no_data without inventing zeroed stats", async () => {
    const analysis = vi.fn(async (request: Request) => {
      const { runId } = (await request.clone().json()) as { runId: string };
      return Response.json({
        state: "no_data",
        run_id: runId,
        control_variant: "control",
        missing: "metric_events",
      });
    });
    const response = await results(analysis);
    const body = (await response.json()) as PanelExperimentResultsOutput;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      state: "no_data",
      runId: LATEST_RUN_ID,
      missing: "metric_events",
    });
    expect(body).not.toHaveProperty("stats");
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

describe("panel Experiment Results draft vs missing (SPL-305)", () => {
  it("returns typed no_run for a draft Experiment instead of EXPERIMENT_NOT_FOUND or RUN_NOT_FOUND", async () => {
    const analysis = analysisReturning(statsOutput());
    const response = await results(
      analysis,
      {},
      repository({ runs: [], experiment: experimentRow(ids) }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      state: "no_run",
      recommendedAction: "START_A_RUN",
    });
    expect(analysis).not.toHaveBeenCalled();
  });

  it("returns EXPERIMENT_NOT_FOUND for a missing Experiment before any analysis read", async () => {
    const analysis = analysisReturning(statsOutput());
    const response = await results(analysis, {}, repository({ experiment: null }));

    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe("EXPERIMENT_NOT_FOUND");
    expect(analysis).not.toHaveBeenCalled();
  });
});
