import { describe, expect, it } from "vitest";
import type { MetricQueryConfig } from "@splitch/contracts";
import { readMetricRows, readPrePeriodRows } from "./results-metric-query";
import { makeResultsHarness, RESULTS_PATH, resultsAuthInit } from "./results-test-harness";
import { FakeTinybird, RUN_ID, rowsByPipe } from "./results-test-support";

describe("GET experiment results Metric query contract", () => {
  it("uses the Run snapshot source binding and a bounded time range", async () => {
    const { app, tinybird } = makeResultsHarness(rowsByPipe());

    const res = await app.request(`${RESULTS_PATH}?runId=${RUN_ID}`, resultsAuthInit("GET"));

    expect(res.status).toBe(200);
    const metricCall = tinybird.calls.find(
      (call) => call.pipeName === "analysis_metric_values_batch",
    );
    expect(metricCall?.params).toMatchObject({
      app_id: "app_checkout",
      environment_id: "env_prod",
      experiment_id: "exp_checkout_banner",
      run_id: RUN_ID,
      from_ts: "2026-07-01 00:00:00.000",
    });
    expect(JSON.parse(metricCall?.params.metric_query_config ?? "null")).toEqual([
      expect.objectContaining({
        metric_id: "conversion",
        event_definition_id: "event_definition_conversion",
        window_duration_ms: 259_200_000,
      }),
    ]);
    expect(metricCall?.params.to_ts).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
    expect(metricCall?.options).toEqual({ method: "POST" });

    const prePeriodCall = tinybird.calls.find(
      (call) => call.pipeName === "analysis_pre_period_covariates_batch",
    );
    expect(prePeriodCall?.params).toMatchObject({
      from_ts: "2026-06-24 00:00:00.000",
    });
    expect(prePeriodCall?.params.metric_query_config).toBe(metricCall?.params.metric_query_config);
    expect(prePeriodCall?.params.to_ts).toBe(metricCall?.params.to_ts);
    expect(prePeriodCall?.options).toEqual({ method: "POST" });
  });

  it("queries Count, Revenue, and Ratio Metrics from their frozen source bindings", async () => {
    const tinybird = new FakeTinybird({});
    const configs: MetricQueryConfig[] = [
      scalarConfig("duration", "count", "event_definition_llm", "duration_ms"),
      scalarConfig("cost", "revenue", "event_definition_llm", "cost_usd"),
      {
        metric_id: "errors_per_request",
        metric_type: "ratio",
        numerator: {
          metric_id: "errors",
          metric_type: "count",
          event_definition_id: "event_definition_llm",
          event_field_name: "error_count",
        },
        denominator: {
          metric_id: "requests",
          metric_type: "count",
          event_definition_id: "event_definition_llm",
          event_field_name: "request_count",
        },
        window_duration_ms: 60_000,
        cuped_lookback_ms: 86_400_000,
      },
    ];
    const scope = {
      app_id: "app_neuron",
      environment_id: "env_prod",
      experiment_id: "exp_models",
      run_id: "run_models_1",
    };

    await readMetricRows(
      tinybird,
      scope,
      configs,
      "2026-08-01T00:00:00.000Z",
      "2026-08-02 00:00:00.000",
    );
    await readPrePeriodRows(
      tinybird,
      scope,
      configs,
      "2026-08-01T00:00:00.000Z",
      "2026-08-02 00:00:00.000",
    );

    expect(tinybird.calls.map((call) => call.pipeName)).toEqual([
      "analysis_metric_values_batch",
      "analysis_pre_period_covariates_batch",
    ]);
    const metricConfigs = JSON.parse(tinybird.calls[0]?.params.metric_query_config ?? "null");
    expect(metricConfigs).toEqual(configs);
    const prePeriodConfigs = JSON.parse(tinybird.calls[1]?.params.metric_query_config ?? "null");
    expect(prePeriodConfigs).toEqual(configs.slice(0, 2));
  });
});

function scalarConfig(
  metricId: string,
  metricType: "count" | "revenue",
  eventDefinitionId: string,
  eventFieldName: string,
): MetricQueryConfig {
  return {
    metric_id: metricId,
    metric_type: metricType,
    event_definition_id: eventDefinitionId,
    event_field_name: eventFieldName,
    window_duration_ms: 60_000,
    cuped_lookback_ms: 86_400_000,
  };
}
