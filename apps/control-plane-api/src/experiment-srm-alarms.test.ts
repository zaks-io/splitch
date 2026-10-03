import {
  ANALYSIS_V1_VERSION,
  ANALYSIS_V2_VERSION,
  evaluateExperimentDecisionGate,
  overlayPersistedSrmAlarms,
  type PersistedSrmAlarm,
  produceExperimentResults,
} from "@splitch/contracts";
import type { Repository } from "@splitch/db";
import { describe, expect, it, vi } from "vitest";
import { syncAnalysisV2SrmAlarms } from "./experiment-results-enrich";
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

describe("durable analysis-v2 SRM alarms", () => {
  it("persists the first 45/45 crossing and still blocks after quarantine lifts live p", async () => {
    const crossedP = 0.0009455653996124124;
    const quarantineP = 0.0012344881606050938;
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
    // First crossing wins: quarantine read must not overwrite.
    expect(repo.runSrmAlarms.insertIgnore).toHaveBeenCalledTimes(1);

    const gate = evaluateExperimentDecisionGate(quarantineStats, CONTROL, DURATION, secondRead);
    expect(gate.shipAllowed).toBe(false);
    expect(gate.blockedBy).toContain("exposure_srm");

    const produced = produceExperimentResults({
      view: "detailed",
      analysis: {
        state: "ready",
        run_id: run.id,
        control_variant: "control",
        stats: quarantineStats,
        data_watermark: "2026-07-03T00:00:00.000Z",
        result_token: `sha256:${"a".repeat(64)}`,
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
    expect(produced.stats.srm.srm_is_mismatch).toBe(true);
    expect(produced.persisted_srm_alarms?.[0]?.firstCrossedAt).toBe(firstRead[0]?.firstCrossedAt);
    expect(produced.gate.shipAllowed).toBe(false);
    expect(produced.readiness.concludeExecutable).toBe(false);
  });

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
