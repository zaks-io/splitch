import { experimentSignificanceDisplays } from "@splitch/contracts";
import { cleanScenario } from "@splitch/contracts/testing";
import { describe, expect, it, vi } from "vitest";
import { createPanelExperimentsClient } from "./panel-experiments";

describe("panel experiment results tolerant parsing", () => {
  it("tolerates additive fields on panel experiment results through the client", async () => {
    const ready = panelResultsReady();
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        ...ready,
        futureEnvelopeField: "envelope-level",
        stats: {
          ...ready.stats,
          arm_results: ready.stats.arm_results.map((arm) => ({
            ...arm,
            futureArmField: "arm-level",
          })),
        },
      }),
    );

    const result = await createPanelExperimentsClient({ fetch: fetcher }).results({
      appId: "app_1",
      environmentId: "env_1",
      experimentId: "exp_1",
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        state: "ready",
        runId: "run_1",
        stats: {
          arm_results: [{ variant: "treatment", sample_size_n: 12_480 }],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("futureEnvelopeField");
    expect(JSON.stringify(result)).not.toContain("futureArmField");
  });

  it("fails loud when panel experiment results omit a required field despite additives", async () => {
    const ready = panelResultsReady();
    const { runStatus: _dropped, ...withoutRunStatus } = ready;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ ...withoutRunStatus, futureEnvelopeField: true }),
    );

    await expect(
      createPanelExperimentsClient({ fetch: fetcher }).results({
        appId: "app_1",
        environmentId: "env_1",
        experimentId: "exp_1",
      }),
    ).rejects.toThrow("panel_experiment_results returned an invalid response body");
  });
});

function panelResultsReady() {
  const { stats, control, gate, srm } = cleanScenario();
  return {
    state: "ready" as const,
    runId: "run_1",
    runNumber: 1,
    runStatus: "running" as const,
    control,
    readiness: { statistical: gate.shipAllowed, concludeExecutable: false },
    blockedBy: gate.blockedBy,
    reasons: [],
    recommendationUnavailable: "no_pre_registration" as const,
    stats,
    srm,
    gate,
    significance: experimentSignificanceDisplays(stats),
  };
}
