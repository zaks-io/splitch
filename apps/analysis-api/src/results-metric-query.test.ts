import { describe, expect, it } from "vitest";
import { makeResultsHarness, RESULTS_PATH, resultsAuthInit } from "./results-test-harness";
import { RUN_ID, rowsByPipe } from "./results-test-support";

describe("GET experiment results Metric query contract", () => {
  it("uses the frozen source binding and a bounded time range", async () => {
    const { app, tinybird } = makeResultsHarness(rowsByPipe());

    const res = await app.request(`${RESULTS_PATH}?runId=${RUN_ID}`, resultsAuthInit("GET"));

    expect(res.status).toBe(200);
    const metricCall = tinybird.calls.find((call) => call.pipeName === "analysis_metric_values");
    expect(metricCall?.params).toMatchObject({
      app_id: "app_checkout",
      environment_id: "env_prod",
      experiment_id: "exp_checkout_banner",
      run_id: RUN_ID,
      metric_id: "conversion",
      event_definition_id: "event_definition_conversion",
      window_duration_ms: "259200000",
      from_ts: "2026-07-01 00:00:00.000",
    });
    expect(metricCall?.params.to_ts).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);

    const prePeriodCall = tinybird.calls.find(
      (call) => call.pipeName === "analysis_pre_period_covariates",
    );
    expect(prePeriodCall?.params).toMatchObject({
      metric_id: "conversion",
      event_definition_id: "event_definition_conversion",
      lookback_ms: "604800000",
      from_ts: "2026-06-24 00:00:00.000",
    });
    expect(prePeriodCall?.params.to_ts).toBe(metricCall?.params.to_ts);
  });
});
