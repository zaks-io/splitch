import {
  ANALYSIS_V1_VERSION,
  ANALYSIS_V2_VERSION,
  createResultToken,
  type PersistedSrmAlarm,
} from "@splitch/contracts";
import type { Repository } from "@splitch/db";
import {
  evaluateExperimentDecisionGate,
  experimentSrmDiagnostics,
  overlayPersistedSrmAlarms,
  produceExperimentResults,
} from "@splitch/stats";
import { describe, expect, it, vi } from "vitest";
import {
  SrmAlarmWatermarkRequiredError,
  syncAnalysisV2SrmAlarms,
} from "./experiment-results-enrich";
import { statsOutput } from "./panel-experiments-test-fixtures";

const CONTROL = {
  state: "frozen" as const,
  variantId: "variant_control",
  variant: "control",
};

const DURATION = {
  plannedDurationDays: 7,
  overrideReason: null as string | null,
  runStartedAt: "2026-07-01T00:00:00.000Z",
  dataWatermark: "2026-07-08T00:00:00.000Z",
};

function alarmRepo() {
  const stored: Array<{
    runId: string;
    srmKind: PersistedSrmAlarm["srmKind"];
    firstCrossedAt: string;
    watermark: string;
    pValue: number;
    analysisVersion: string;
  }> = [];
  const repo = {
    runSrmAlarms: {
      insertIgnore: vi.fn(async (_scope, input) => {
        if (!stored.some((row) => row.runId === input.runId && row.srmKind === input.srmKind)) {
          stored.push({ ...input });
        }
      }),
      listForRun: vi.fn(async (_scope, runId: string) =>
        stored
          .filter((row) => row.runId === runId)
          .map((row) => ({
            ...row,
            appId: "app_1",
            environmentId: "env_1",
          })),
      ),
      deleteForRun: vi.fn(async () => undefined),
    },
  } as unknown as Repository;
  return { repo, stored };
}

describe("durable analysis-v2 SRM alarms: near-threshold sticky", () => {
  it("persists the first 45/45 crossing and still blocks after quarantine lifts live p", async () => {
    const crossedP = 0.0009455653996124124;
    const quarantineP = 0.0012344881606050938;
    const { repo } = alarmRepo();

    const run = {
      id: "run_near",
      appId: "app_1",
      environmentId: "env_1",
      analysisVersion: ANALYSIS_V2_VERSION,
    };
    const crossedStats = statsOutput({
      srm: {
        ...statsOutput().srm,
        srm_p_value: crossedP,
        srm_is_mismatch: true,
        srm_sequential_threshold_crossed: true,
        activated_srm_sequential_threshold_crossed: null,
      },
    });
    const firstRead = await syncAnalysisV2SrmAlarms(
      repo,
      run,
      crossedStats,
      "2026-07-02T00:00:00.000Z",
    );
    expect(firstRead).toHaveLength(1);
    expect(firstRead[0]?.srmKind).toBe("exposure");
    expect(firstRead[0]?.pValue).toBe(crossedP);
    expect(repo.runSrmAlarms.insertIgnore).toHaveBeenCalledTimes(1);

    const quarantineStats = statsOutput({
      srm: {
        ...statsOutput().srm,
        srm_p_value: quarantineP,
        srm_is_mismatch: false,
        srm_sequential_threshold_crossed: false,
        activated_srm_sequential_threshold_crossed: null,
        observed_counts: { control: 44, treatment: 45 },
        expected_counts: { control: 44.5, treatment: 44.5 },
      },
    });
    const secondRead = await syncAnalysisV2SrmAlarms(
      repo,
      run,
      quarantineStats,
      "2026-07-03T00:00:00.000Z",
    );
    expect(secondRead).toHaveLength(1);
    expect(secondRead[0]?.firstCrossedAt).toBe(firstRead[0]?.firstCrossedAt);
    expect(secondRead[0]?.pValue).toBe(crossedP);
    expect(repo.runSrmAlarms.insertIgnore).toHaveBeenCalledTimes(1);

    const gate = evaluateExperimentDecisionGate(quarantineStats, CONTROL, DURATION, secondRead);
    expect(gate.shipAllowed).toBe(false);
    expect(gate.blockedBy).toContain("exposure_srm");

    const tokenIdentity = {
      appId: "app_1",
      environmentId: "env_1",
      experimentId: "exp_1",
      runId: run.id,
      runConfigHash: "sha256:config",
      analysisVersion: ANALYSIS_V2_VERSION,
    };
    const resultToken = await createResultToken({
      ...tokenIdentity,
      stats: quarantineStats,
    });
    const produced = produceExperimentResults({
      view: "detailed",
      analysis: {
        state: "ready",
        run_id: run.id,
        control_variant: "control",
        stats: quarantineStats,
        data_watermark: "2026-07-03T00:00:00.000Z",
        result_token: resultToken,
      },
      run: {
        runNumber: 1,
        runStatus: "running",
        control: CONTROL,
        duration: DURATION,
      },
      canConclude: true,
      persistedSrmAlarms: secondRead,
    });
    expect(produced.state).toBe("ready");
    if (produced.state !== "ready" || produced.view !== "detailed") return;
    expect(produced.stats).toEqual(quarantineStats);
    expect(produced.stats.srm.srm_is_mismatch).toBe(false);
    expect(produced.persisted_srm_alarms?.[0]?.firstCrossedAt).toBe(firstRead[0]?.firstCrossedAt);
    expect(produced.gate.shipAllowed).toBe(false);
    expect(produced.readiness.concludeExecutable).toBe(false);
    expect(experimentSrmDiagnostics(produced.stats, null, secondRead).exposure.tier).toBe(
      "confirmed",
    );
    expect(
      await createResultToken({
        ...tokenIdentity,
        stats: produced.stats,
      }),
    ).toBe(resultToken);
  });
});

describe("durable analysis-v2 SRM alarms: insufficient-data sentinel", () => {
  it("does not persist the zero-Activation insufficient-data sentinel", async () => {
    const { repo } = alarmRepo();
    const alarms = await syncAnalysisV2SrmAlarms(
      repo,
      {
        id: "run_empty_act",
        appId: "app_1",
        environmentId: "env_1",
        analysisVersion: ANALYSIS_V2_VERSION,
      },
      statsOutput({
        srm: {
          ...statsOutput().srm,
          activated_srm_p_value: 0,
          activated_srm_mismatch: true,
          srm_sequential_threshold_crossed: false,
          activated_srm_sequential_threshold_crossed: false,
        },
      }),
      "2026-07-02T00:00:00.000Z",
    );
    expect(alarms).toEqual([]);
    expect(repo.runSrmAlarms.insertIgnore).not.toHaveBeenCalled();

    const balancedLater = await syncAnalysisV2SrmAlarms(
      repo,
      {
        id: "run_empty_act",
        appId: "app_1",
        environmentId: "env_1",
        analysisVersion: ANALYSIS_V2_VERSION,
      },
      statsOutput({
        srm: {
          ...statsOutput().srm,
          activated_srm_p_value: 0.5,
          activated_srm_mismatch: false,
          srm_sequential_threshold_crossed: false,
          activated_srm_sequential_threshold_crossed: false,
        },
      }),
      "2026-07-03T00:00:00.000Z",
    );
    expect(balancedLater).toEqual([]);
    const gate = evaluateExperimentDecisionGate(
      statsOutput({
        srm: {
          ...statsOutput().srm,
          activated_srm_p_value: 0.5,
          activated_srm_mismatch: false,
          srm_sequential_threshold_crossed: false,
          activated_srm_sequential_threshold_crossed: false,
        },
      }),
      CONTROL,
      DURATION,
      balancedLater,
    );
    expect(gate.blockedBy).not.toContain("activated_srm");
  });
});

describe("durable analysis-v2 SRM alarms: watermark required", () => {
  it("fails loud and inserts nothing when a crossing has no data_watermark", async () => {
    const { repo } = alarmRepo();
    await expect(
      syncAnalysisV2SrmAlarms(
        repo,
        {
          id: "run_no_watermark",
          appId: "app_1",
          environmentId: "env_1",
          analysisVersion: ANALYSIS_V2_VERSION,
        },
        statsOutput({
          srm: {
            ...statsOutput().srm,
            srm_p_value: 0.0001,
            srm_is_mismatch: true,
            srm_sequential_threshold_crossed: true,
            activated_srm_sequential_threshold_crossed: null,
          },
        }),
        undefined,
      ),
    ).rejects.toBeInstanceOf(SrmAlarmWatermarkRequiredError);
    expect(repo.runSrmAlarms.insertIgnore).not.toHaveBeenCalled();
  });
});

describe("durable analysis-v2 SRM alarms: analysis-v1 isolation", () => {
  it("never reads or writes alarms for analysis-v1 Runs", async () => {
    const repo = {
      runSrmAlarms: {
        insertIgnore: vi.fn(async () => undefined),
        listForRun: vi.fn(async () => {
          throw new Error("v1 must not list alarms");
        }),
        deleteForRun: vi.fn(async () => undefined),
      },
    } as unknown as Repository;

    const alarms = await syncAnalysisV2SrmAlarms(
      repo,
      {
        id: "run_v1",
        appId: "app_1",
        environmentId: "env_1",
        analysisVersion: ANALYSIS_V1_VERSION,
      },
      statsOutput({
        srm: { ...statsOutput().srm, srm_p_value: 0.0001, srm_is_mismatch: true },
      }),
      "2026-07-02T00:00:00.000Z",
    );
    expect(alarms).toEqual([]);
    expect(repo.runSrmAlarms.insertIgnore).not.toHaveBeenCalled();
    expect(
      overlayPersistedSrmAlarms(
        statsOutput({ srm: { ...statsOutput().srm, srm_is_mismatch: false } }),
        [],
      ).srm.srm_is_mismatch,
    ).toBe(false);
  });
});
