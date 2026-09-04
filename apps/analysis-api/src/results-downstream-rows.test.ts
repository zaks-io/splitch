import { AnalysisResultsEnvelopeSchema } from "@splitch/contracts";
import { describe, expect, it, vi } from "vitest";
import { readDownstreamAnalysisRows } from "./results-downstream-rows";
import { makeResultsHarness, RESULTS_PATH, resultsAuthInit } from "./results-test-harness";
import { RUN_ID, rowsByPipe } from "./results-test-support";

describe("readDownstreamAnalysisRows", () => {
  it("reads only activation health when a gated Run has no analyzed Metrics", async () => {
    const activationRows = [{ targeting_key_hash: "control_0", activated: true }];
    const readPipe = vi.fn(async () => activationRows);
    const params = { app_id: "app_1", environment_id: "env_1", run_id: "run_1" };

    await expect(
      readDownstreamAnalysisRows({
        tinybird: { readPipe },
        params,
        metricQueryConfig: [],
        startedAt: "2026-01-01T00:00:00.000Z",
        toTs: "2026-01-02T00:00:00.000Z",
        activationGated: true,
        hasAnalyzedMetrics: false,
      }),
    ).resolves.toEqual({ metricRows: [], prePeriodRows: [], activationRows });
    expect(readPipe).toHaveBeenCalledExactlyOnceWith("analysis_activation_rows", params);
  });
});

describe("GET experiment results activation health", () => {
  it("returns activation health without querying per-Metric pipes for a gated Run with no Metrics", async () => {
    const rows = rowsByPipe();
    const [runInput] = rows.analysis_run_inputs as Record<string, unknown>[];
    const { app, tinybird } = makeResultsHarness({
      ...rows,
      analysis_run_inputs: [
        {
          ...runInput,
          activation_metric_id: "metric_activation",
          decision_family: JSON.stringify([]),
          guardrail_decisions: JSON.stringify([]),
        },
      ],
      analysis_metric_values_batch: [],
      analysis_pre_period_covariates_batch: [],
      analysis_activation_rows: [
        {
          targeting_key_hash: "control_0",
          run_id: RUN_ID,
          activation_ts: "2026-07-01T01:00:00.000Z",
          counterfactual: false,
          activated: true,
        },
      ],
    });

    const res = await app.request(`${RESULTS_PATH}?runId=${RUN_ID}`, resultsAuthInit("GET"));

    expect(res.status).toBe(200);
    expect(AnalysisResultsEnvelopeSchema.parse(await res.json())).toMatchObject({
      state: "ready",
      run_id: RUN_ID,
      control_variant: "control",
      stats: { health: { activation_rates: { control: 0.5, treatment: 0 } } },
    });
    expect(tinybird.calls.map((call) => call.pipeName)).toEqual([
      "analysis_run_bootstrap",
      "analysis_activation_rows",
    ]);
  });
});
