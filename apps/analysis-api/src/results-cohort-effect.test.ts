import {
  ANALYSIS_V1_VERSION,
  AnalysisResultsEnvelopeSchema,
  LEGACY_RUN_COMMITMENTS,
} from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { readyAnalysisEnvelope } from "./results-cohort-effect";
import { makeResultsHarness, RESULTS_PATH, resultsAuthInit } from "./results-test-harness";
import {
  APP_ID,
  DATA_WATERMARK,
  ENVIRONMENT_ID,
  type RowsByPipe,
  RUN_ID,
  rowsByPipe,
} from "./results-test-support";

describe("readyAnalysisEnvelope cohort_effect", () => {
  it("still returns Results when a bucket has zero sampling variance", () => {
    const statsInput = zeroVarianceStatsInput();
    const envelope = readyAnalysisEnvelope({
      statsInput,
      runStartedAt: "2026-07-01T00:00:00.000Z",
      commitments: LEGACY_RUN_COMMITMENTS,
      stats: emptyStats(),
      evidence: {
        data_watermark: DATA_WATERMARK,
        result_token: `sha256:${"c".repeat(64)}`,
      },
    });

    const parsed = AnalysisResultsEnvelopeSchema.parse(envelope);
    expect(parsed.state).toBe("ready");
    if (parsed.state !== "ready") throw new Error("expected ready");
    expect(parsed.cohort_effect?.state).toBe("ready");
    if (parsed.cohort_effect?.state !== "ready") throw new Error("expected ready cohort_effect");
    const day0 = parsed.cohort_effect.comparisons[0]?.buckets[0];
    expect(day0).toMatchObject({
      status: "zero_variance",
      absolute_effect: 0,
      absolute_ci_lower: null,
      absolute_ci_upper: null,
    });
  });
});

describe("Experiment Results cohort_effect zero-variance regression", () => {
  it("returns HTTP 200 with zero_variance buckets instead of failing Results", async () => {
    const fixture = zeroVarianceRowsByPipe();
    const { app } = makeResultsHarness(fixture);
    const response = await app.request(`${RESULTS_PATH}?runId=${RUN_ID}`, resultsAuthInit("GET"));
    expect(response.status).toBe(200);
    const envelope = AnalysisResultsEnvelopeSchema.parse(await response.json());
    expect(envelope.state).toBe("ready");
    if (envelope.state !== "ready") throw new Error("expected ready");
    expect(envelope.cohort_effect?.state).toBe("ready");
    if (envelope.cohort_effect?.state !== "ready") throw new Error("expected ready cohort_effect");
    expect(envelope.cohort_effect.comparisons[0]?.buckets[0]?.status).toBe("zero_variance");
  });
});

describe("Experiment Results Retention primary cohort_effect", () => {
  it("returns HTTP 200 when the primary Metric is Retention", async () => {
    const fixture = retentionPrimaryRowsByPipe();
    const { app } = makeResultsHarness(fixture);
    const response = await app.request(`${RESULTS_PATH}?runId=${RUN_ID}`, resultsAuthInit("GET"));
    expect(response.status).toBe(200);
    const envelope = AnalysisResultsEnvelopeSchema.parse(await response.json());
    expect(envelope.state).toBe("ready");
  });
});

function zeroVarianceStatsInput() {
  const exposures = [];
  const metric_values = [];
  for (const variant of ["control", "treatment"] as const) {
    for (let index = 0; index < 40; index += 1) {
      const key = `${variant}_${index}`;
      exposures.push({
        app_id: APP_ID,
        targeting_key_hash: key,
        environment_id: ENVIRONMENT_ID,
        id_type: "user" as const,
        run_id: RUN_ID,
        variant,
        first_exposure_ts: "2026-07-01T00:00:00.000Z",
        window_anchor: "2026-07-01T00:00:00.000Z",
      });
      metric_values.push({
        targeting_key_hash: key,
        run_id: RUN_ID,
        metric_id: "conversion",
        metric_type: "binomial" as const,
        value: 0,
        in_window: true,
      });
    }
  }
  return {
    run_id: RUN_ID,
    analysis_version: ANALYSIS_V1_VERSION,
    confidence_level: 0.95,
    horizon: "sequential" as const,
    allocation: { control: 50, treatment: 50 },
    control_variant: "control",
    decision_family: [{ metric_id: "conversion", variant: "treatment" }],
    guardrail_decisions: [],
    metric_variance_config: [],
    exposures,
    metric_values,
  };
}

function emptyStats() {
  return {
    arm_results: [],
    srm: {
      srm_p_value: 1,
      srm_is_mismatch: false,
      observed_counts: { control: 40, treatment: 40 },
      expected_counts: { control: 40, treatment: 40 },
      activated_srm_p_value: null,
      activated_srm_mismatch: null,
    },
    guardrail_results: [],
    health: {
      multiple_rate: 0,
      multiple_count: 0,
      activation_rates: null,
      activation_balance_p_value: null,
      activation_balance_mismatch: null,
      exposure_counts: { control: 40, treatment: 40 },
      deduped_counts: { control: 40, treatment: 40 },
      low_n_warning: false,
    },
  };
}

function zeroVarianceRowsByPipe(): RowsByPipe {
  const fixture = rowsByPipe();
  const exposures = [];
  const metricValues = [];
  for (const variant of ["control", "treatment"]) {
    for (let index = 0; index < 40; index += 1) {
      const targeting_key_hash = `${variant}_${index}`;
      exposures.push({
        app_id: APP_ID,
        environment_id: ENVIRONMENT_ID,
        id_type: "user",
        targeting_key_hash,
        run_id: RUN_ID,
        variant,
        first_exposure_ts: "2026-07-01T00:00:00.000Z",
        window_anchor: "2026-07-01T00:00:00.000Z",
      });
      metricValues.push({
        targeting_key_hash,
        run_id: RUN_ID,
        metric_id: "conversion",
        metric_type: "binomial",
        value: 0,
        in_window: 1,
      });
    }
  }
  fixture.analysis_deduped_exposures = exposures;
  fixture.analysis_metric_values_batch = metricValues;
  return fixture;
}

function retentionPrimaryRowsByPipe(): RowsByPipe {
  const fixture = zeroVarianceRowsByPipe();
  const run = fixture.analysis_run_inputs?.[0] as Record<string, unknown>;
  fixture.analysis_run_inputs = [
    {
      ...run,
      decision_family: JSON.stringify([{ metric_id: "d7_retained", variant: "treatment" }]),
      metric_query_config: JSON.stringify([
        {
          metric_id: "d7_retained",
          metric_type: "retention",
          event_definition_id: "event_definition_signup",
          event_field_name: null,
          window_offset_ms: 0,
          window_duration_ms: 86_400_000,
          horizon_start_ms: 0,
          horizon_end_ms: 86_400_000,
          cuped_lookback_ms: 604_800_000,
        },
      ]),
    },
  ];
  fixture.analysis_metric_values_batch = (fixture.analysis_metric_values_batch ?? []).map(
    (row) => ({
      ...(row as Record<string, unknown>),
      metric_id: "d7_retained",
      metric_type: "retention",
    }),
  );
  return fixture;
}
