import { describe, expect, it } from "vitest";
import { MetricKindSchema, MetricSchema } from "./leaf-schemas-experiment";
import { AnalysisResultsEnvelopeSchema } from "./stats-result-contract";
import { ArmResultSchema } from "./stats-result-arm";
import { MetricQueryConfigSchema, StatsInputSchema } from "./stats-input-contract";

/**
 * Deploy-order compat: Analysis can emit Retention result fields and parse
 * Retention Metric query configs before Control Plane deploys the producer, and
 * Control Plane can store kind=retention before Analysis consumes it.
 */

const armResult = {
  variant: "treatment",
  metric_id: "metric_retention",
  sample_size_n: 80,
  point_estimate: 0.4,
  relative_lift_pct: 10,
  ci_lower: 1,
  ci_upper: 20,
  p_value: 0.04,
  is_significant: true,
  in_bh_family: true,
  exploratory: false,
  decision_valid: true,
  status: "ready" as const,
  variance_techniques: {
    winsorized: false,
    winsorize_pct: null,
    winsorize_cap: null,
    cuped_applied: false,
    cuped_method: null,
    cuped_attribute: null,
    cuped_attribute_source: null,
    cuped_coverage_pct: null,
    delta_method: false,
  },
};

const envelopeBase = {
  state: "ready" as const,
  run_id: "run_retention_compat",
  control_variant: "control",
  stats: {
    arm_results: [armResult],
    srm: {
      srm_p_value: 1,
      srm_is_mismatch: false,
      observed_counts: { control: 100, treatment: 100 },
      expected_counts: { control: 100, treatment: 100 },
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
      exposure_counts: { control: 100, treatment: 100 },
      deduped_counts: { control: 100, treatment: 100 },
      low_n_warning: true,
    },
  },
};

const statsInput = {
  run_id: "run_1",
  allocation: { control: 50, treatment: 50 },
  control_variant: "control",
  decision_family: [{ metric_id: "metric_1", variant: "treatment" }],
  guardrail_decisions: [],
  exposures: [
    {
      app_id: "app_1",
      targeting_key_hash: "tkh_1",
      environment_id: "env_1",
      id_type: "user",
      run_id: "run_1",
      variant: "treatment",
      first_exposure_ts: "2026-07-01T00:00:00.000Z",
      window_anchor: "2026-07-01T00:00:00.000Z",
    },
  ],
  metric_values: [
    {
      targeting_key_hash: "tkh_1",
      run_id: "run_1",
      metric_id: "metric_1",
      metric_type: "binomial",
      value: 1,
      in_window: true,
    },
  ],
};

describe("Retention Metric deploy compatibility", () => {
  it("accepts kind=retention on the Metric leaf and MetricKind enum", () => {
    expect(MetricKindSchema.parse("retention")).toBe("retention");
    const metric = MetricSchema.parse({
      id: "metric_1",
      appId: "app_1",
      key: "d7-retained",
      name: "D7 retained",
      kind: "retention",
      eventDefinitionId: "session_started",
      horizonStartMs: 6 * 86_400_000,
      horizonEndMs: 7 * 86_400_000,
      createdAt: "2026-07-01T00:00:00Z",
    });
    expect(metric.horizonStartMs).toBe(6 * 86_400_000);
    expect(metric.horizonEndMs).toBe(7 * 86_400_000);
  });

  it("accepts a Metric without horizon fields (pre-Retention payloads)", () => {
    const metric = MetricSchema.parse({
      id: "metric_1",
      appId: "app_1",
      key: "checkout-conversion",
      name: "Checkout Conversion",
      kind: "binomial",
      eventDefinitionId: "checkout_completed",
      createdAt: "2026-07-01T00:00:00Z",
    });
    expect(metric.horizonStartMs).toBeUndefined();
  });

  it("accepts a Retention MetricQueryConfig and a Binomial config without offset", () => {
    expect(
      MetricQueryConfigSchema.parse({
        metric_id: "d7",
        metric_type: "retention",
        event_definition_id: "session_started",
        event_field_name: null,
        window_duration_ms: 86_400_000,
        window_offset_ms: 6 * 86_400_000,
        horizon_start_ms: 6 * 86_400_000,
        horizon_end_ms: 7 * 86_400_000,
        cuped_lookback_ms: 604_800_000,
      }).metric_type,
    ).toBe("retention");
    expect(
      MetricQueryConfigSchema.parse({
        metric_id: "conversion",
        metric_type: "binomial",
        event_definition_id: "checkout",
        event_field_name: null,
        window_duration_ms: 259_200_000,
        cuped_lookback_ms: 604_800_000,
      }).window_offset_ms,
    ).toBeUndefined();
  });

  it("accepts ArmResult with and without Retention eligibility fields", () => {
    expect(ArmResultSchema.parse(armResult).eligible_n).toBeUndefined();
    const withEligibility = ArmResultSchema.parse({
      ...armResult,
      eligible_n: 80,
      immature_excluded_n: 20,
    });
    expect(withEligibility.eligible_n).toBe(80);
    expect(withEligibility.immature_excluded_n).toBe(20);
  });

  it("accepts a ready Analysis envelope whose arms carry Retention eligibility", () => {
    const envelope = AnalysisResultsEnvelopeSchema.parse({
      ...envelopeBase,
      stats: {
        ...envelopeBase.stats,
        arm_results: [{ ...armResult, eligible_n: 80, immature_excluded_n: 20 }],
      },
    });
    expect(envelope.state).toBe("ready");
  });

  it("accepts StatsInput with and without data_watermark and Retention horizons", () => {
    expect(StatsInputSchema.parse(statsInput).data_watermark).toBeUndefined();
    const withRetention = StatsInputSchema.parse({
      ...statsInput,
      data_watermark: "2026-07-08T00:00:00.000Z",
      metric_retention_horizons: [
        {
          metric_id: "d7",
          horizon_start_ms: 6 * 86_400_000,
          horizon_end_ms: 7 * 86_400_000,
        },
      ],
    });
    expect(withRetention.metric_retention_horizons?.[0]?.metric_id).toBe("d7");
  });
});
