import { ANALYSIS_V2_VERSION } from "@splitch/contracts";
import { describe, expect, it, vi } from "vitest";
import { ids, repository } from "./panel-experiment-results-test-harness";
import { panelExperimentsList } from "./panel-experiments";
import {
  analysisEnvelope,
  experimentRow,
  runRow,
  statsOutput,
} from "./panel-experiments-test-fixtures";

function harness() {
  const run = { ...runRow(ids, 2), analysisVersion: ANALYSIS_V2_VERSION };
  const repo = repository({ runs: [run] });
  const stored: Array<{
    appId: string;
    environmentId: string;
    runId: string;
    srmKind: "exposure" | "activated";
    firstCrossedAt: string;
    watermark: string;
    pValue: number;
    analysisVersion: string;
  }> = [];
  repo.experiments.listExperiments = vi.fn(async () => [experimentRow(ids)] as never);
  vi.mocked(repo.runSrmAlarms.listForRun).mockImplementation(async () => [...stored]);
  vi.mocked(repo.runSrmAlarms.insertIgnore).mockImplementation(async (_scope, alarm) => {
    if (!stored.some((row) => row.srmKind === alarm.srmKind)) {
      stored.push({ appId: ids.appId, environmentId: ids.environmentId, ...alarm });
    }
  });
  const stats = statsOutput();
  const analysis = vi.fn(async () =>
    Response.json(
      analysisEnvelope(run.id, stats, {
        data_watermark: "2026-07-25T00:00:00.000Z",
        result_token: `sha256:${"a".repeat(64)}`,
      }),
    ),
  );
  const list = () =>
    panelExperimentsList(
      { repo, analysis: { fetch: analysis } as unknown as Fetcher },
      { actorId: ids.actorId, appId: ids.appId, environmentId: ids.environmentId },
    );
  return { repo, stored, stats, analysis, list, run };
}

describe("Experiment list durable SRM health", () => {
  it.each(["exposure", "activated"] as const)(
    "keeps a persisted %s alarm firing after live statistics recover",
    async (srmKind) => {
      const { stored, list, run } = harness();
      stored.push({
        appId: ids.appId,
        environmentId: ids.environmentId,
        runId: run.id,
        srmKind,
        firstCrossedAt: "2026-07-21T00:00:00.000Z",
        watermark: "2026-07-21T00:00:00.000Z",
        pValue: 0.0009,
        analysisVersion: ANALYSIS_V2_VERSION,
      });
      expect(await (await list()).json()).toMatchObject({
        items: [{ health: { srmFiring: true } }],
      });
    },
  );

  it("persists a crossing first observed by the list and preserves its first evidence", async () => {
    const { repo, stats, list, stored } = harness();
    Object.assign(stats.srm, {
      srm_is_mismatch: true,
      srm_p_value: 0.0009,
      srm_sequential_threshold_crossed: true,
    });
    await list();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ srmKind: "exposure", pValue: 0.0009 });
    const first = { ...stored[0] };
    Object.assign(stats.srm, {
      srm_is_mismatch: false,
      srm_p_value: 0.71,
      srm_sequential_threshold_crossed: false,
    });
    expect(await (await list()).json()).toMatchObject({ items: [{ health: { srmFiring: true } }] });
    expect(stored).toEqual([first]);
    expect(repo.runSrmAlarms.insertIgnore).toHaveBeenCalledTimes(1);
  });

  it("preserves a durable alarm when live Analysis has no rows", async () => {
    const { stored, analysis, list, run } = harness();
    stored.push({
      appId: ids.appId,
      environmentId: ids.environmentId,
      runId: run.id,
      srmKind: "exposure",
      firstCrossedAt: "2026-07-21T00:00:00.000Z",
      watermark: "2026-07-21T00:00:00.000Z",
      pValue: 0.0009,
      analysisVersion: ANALYSIS_V2_VERSION,
    });
    analysis.mockResolvedValue(
      Response.json({
        state: "no_data",
        run_id: run.id,
        control_variant: "control",
        missing: "exposures",
      }),
    );
    expect(await (await list()).json()).toMatchObject({ items: [{ health: { srmFiring: true } }] });
  });

  it("never reads or writes durable alarms for a legacy Run", async () => {
    const { repo, run, list } = harness();
    run.analysisVersion = "analysis-v1";
    await list();
    expect(repo.runSrmAlarms.listForRun).not.toHaveBeenCalled();
    expect(repo.runSrmAlarms.insertIgnore).not.toHaveBeenCalled();
  });

  it("refuses a sequential crossing without an Analysis watermark", async () => {
    const { repo, run, stats, analysis, list } = harness();
    Object.assign(stats.srm, { srm_sequential_threshold_crossed: true });
    analysis.mockResolvedValue(Response.json(analysisEnvelope(run.id, stats)));
    await expect(list()).rejects.toThrow(/without data_watermark/);
    expect(repo.runSrmAlarms.insertIgnore).not.toHaveBeenCalled();
  });

  it("refuses a foreign live Run before touching its alarms", async () => {
    const { repo, run, list } = harness();
    run.experimentId = "another_experiment";
    await expect(list()).rejects.toThrow(/foreign live Run/);
    expect(repo.runSrmAlarms.listForRun).not.toHaveBeenCalled();
    expect(repo.runSrmAlarms.insertIgnore).not.toHaveBeenCalled();
  });
});
