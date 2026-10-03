import { AnalysisResultsEnvelopeSchema } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { makeResultsHarness, RESULTS_PATH, resultsAuthInit } from "./results-test-harness";
import {
  APP_ID,
  ENVIRONMENT_ID,
  type RowsByPipe,
  RUN_ID,
  rowsByPipe,
} from "./results-test-support";

const FIRST_EXPOSURE = "2026-07-01T00:00:00.000Z";
const ACTIVATION = "2026-07-03T00:00:00.000Z";
const SEVEN_DAYS_MS = 7 * 86_400_000;
const JULY_9 = "2026-07-09T00:00:00.000Z";
const JULY_10 = "2026-07-10T00:00:00.000Z";

describe("Experiment Results gated Retention maturity", () => {
  it("does not treat a gated Entity as mature until Activation plus horizon_end", async () => {
    const { app } = makeResultsHarness(gatedRetentionRows(JULY_9));
    const response = await app.request(`${RESULTS_PATH}?runId=${RUN_ID}`, resultsAuthInit("GET"));
    expect(response.status).toBe(200);
    const envelope = AnalysisResultsEnvelopeSchema.parse(await response.json());
    expect(envelope.state).toBe("ready");
    if (envelope.state !== "ready") throw new Error("expected ready");
    expect(
      envelope.stats.arm_results
        .filter((arm) => arm.metric_id === "d7_retained")
        .map((arm) => [arm.variant, arm.sample_size_n, arm.immature_excluded_n]),
    ).toEqual([
      ["control", 0, 1],
      ["treatment", 0, 1],
    ]);
  });

  it("counts the gated Entity once the watermark reaches Activation plus horizon_end", async () => {
    const { app } = makeResultsHarness(gatedRetentionRows(JULY_10));
    const response = await app.request(`${RESULTS_PATH}?runId=${RUN_ID}`, resultsAuthInit("GET"));
    expect(response.status).toBe(200);
    const envelope = AnalysisResultsEnvelopeSchema.parse(await response.json());
    expect(envelope.state).toBe("ready");
    if (envelope.state !== "ready") throw new Error("expected ready");
    expect(
      envelope.stats.arm_results
        .filter((arm) => arm.metric_id === "d7_retained")
        .map((arm) => [arm.variant, arm.sample_size_n, arm.immature_excluded_n]),
    ).toEqual([
      ["control", 1, 0],
      ["treatment", 1, 0],
    ]);
  });
});

function gatedRetentionRows(dataWatermark: string): RowsByPipe {
  const fixture = rowsByPipe();
  const run = fixture.analysis_run_inputs?.[0] as Record<string, unknown>;
  fixture.analysis_run_inputs = [
    {
      ...run,
      data_watermark: dataWatermark,
      activation_metric_id: "metric_activation",
      decision_family: JSON.stringify([{ metric_id: "d7_retained", variant: "treatment" }]),
      metric_query_config: JSON.stringify([
        {
          metric_id: "d7_retained",
          metric_type: "retention",
          event_definition_id: "event_definition_returned",
          event_field_name: null,
          window_offset_ms: 0,
          window_duration_ms: SEVEN_DAYS_MS,
          horizon_start_ms: 0,
          horizon_end_ms: SEVEN_DAYS_MS,
          cuped_lookback_ms: 604_800_000,
        },
      ]),
    },
  ];
  // Tinybird's Exposure pipe leaves window_anchor at first_exposure_ts. Do not
  // pre-supply the Activation as the Conversion Window anchor.
  fixture.analysis_deduped_exposures = [
    exposureWithoutAnchor("control", "control_gated"),
    exposureWithoutAnchor("treatment", "treatment_gated"),
  ];
  fixture.analysis_activation_rows = [
    activationRow("control_gated"),
    activationRow("treatment_gated"),
  ];
  fixture.analysis_metric_values_batch = [
    metricValue("control_gated"),
    metricValue("treatment_gated"),
  ];
  return fixture;
}

function exposureWithoutAnchor(variant: string, targetingKeyHash: string) {
  return {
    app_id: APP_ID,
    environment_id: ENVIRONMENT_ID,
    id_type: "user",
    targeting_key_hash: targetingKeyHash,
    run_id: RUN_ID,
    variant,
    first_exposure_ts: FIRST_EXPOSURE,
  };
}

function activationRow(targetingKeyHash: string) {
  return {
    targeting_key_hash: targetingKeyHash,
    run_id: RUN_ID,
    activation_ts: ACTIVATION,
    counterfactual: false,
    activated: true,
  };
}

function metricValue(targetingKeyHash: string) {
  return {
    targeting_key_hash: targetingKeyHash,
    run_id: RUN_ID,
    metric_id: "d7_retained",
    metric_type: "retention",
    value: 1,
    in_window: 1,
  };
}
