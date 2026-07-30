import type { ArmResult, StatsOutput } from "@splitch/contracts";

/**
 * Stats fixtures for the Overview tests, one per attention state.
 *
 * Every state carries DISTINCT numbers. Identical seeds across states have twice
 * masked real bugs in this repo: a classifier that reads the wrong Run, or a
 * response assembled from the wrong Environment, still looks correct when every
 * fixture is the same row.
 */

const varianceTechniques = {
  winsorized: false,
  winsorize_pct: null,
  winsorize_cap: null,
  cuped_applied: false,
  cuped_method: null,
  cuped_attribute: null,
  cuped_attribute_source: null,
  cuped_coverage_pct: null,
  delta_method: false,
} as const;

function armResult(overrides: Partial<ArmResult> = {}): ArmResult {
  return {
    variant: "treatment",
    metric_id: "metric_checkout_conversion",
    sample_size_n: 1_000,
    point_estimate: 0.02,
    relative_lift_pct: 4.1,
    ci_lower: 0.4,
    ci_upper: 7.8,
    p_value: 0.4,
    is_significant: false,
    in_bh_family: true,
    exploratory: false,
    decision_valid: true,
    status: "running",
    variance_techniques: varianceTechniques,
    ...overrides,
  };
}

interface StatsShape {
  /** Enrolled entities per Variant; also the horizon denominator. */
  deduped: Record<string, number>;
  significant?: boolean;
  srm?: boolean;
  guardrail?: boolean;
  multipleRate?: number;
}

export function overviewStats(shape: StatsShape): StatsOutput {
  const multipleRate = shape.multipleRate ?? 0;
  const enrolled = Object.values(shape.deduped).reduce((total, count) => total + count, 0);
  return {
    arm_results: [
      armResult({
        is_significant: shape.significant ?? false,
        p_value: shape.significant ? 0.004 : 0.4,
        sample_size_n: enrolled,
      }),
    ],
    srm: {
      srm_p_value: shape.srm ? 0.00004 : 0.61,
      srm_is_mismatch: shape.srm ?? false,
      observed_counts: shape.deduped,
      expected_counts: shape.deduped,
      activated_srm_p_value: null,
      activated_srm_mismatch: null,
    },
    guardrail_results: shape.guardrail
      ? [
          {
            metric_id: "metric_checkout_latency",
            variant: "treatment",
            ci_lower: -0.24,
            threshold: -0.1,
            is_breached: true,
            in_bh_family: false,
            exploratory: false,
            decision_valid: true,
            breach_reason: "lower confidence bound crossed threshold",
          },
        ]
      : [],
    health: {
      multiple_rate: multipleRate,
      multiple_count: Math.round(multipleRate * enrolled),
      activation_rates: null,
      activation_balance_p_value: null,
      activation_balance_mismatch: null,
      exposure_counts: shape.deduped,
      deduped_counts: shape.deduped,
      low_n_warning: false,
    },
  };
}
