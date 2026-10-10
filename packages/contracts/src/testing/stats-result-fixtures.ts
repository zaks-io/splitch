import type { ArmResult } from "../stats-result-arm";
import type { StatsOutput } from "../stats-result-contract";

const varianceTechniques: ArmResult["variance_techniques"] = {
  winsorized: false,
  winsorize_pct: null,
  winsorize_cap: null,
  cuped_applied: false,
  cuped_method: null,
  cuped_attribute: null,
  cuped_attribute_source: null,
  cuped_coverage_pct: null,
  delta_method: false,
};

export function armResultFixture(overrides: Partial<ArmResult> = {}): ArmResult {
  return {
    variant: "treatment",
    metric_id: "checkout-conversion",
    sample_size_n: 4_000,
    point_estimate: 0.42,
    relative_lift_pct: 6.5,
    ci_lower: 1.2,
    ci_upper: 11.8,
    p_value: 0.004,
    is_significant: true,
    in_bh_family: true,
    exploratory: false,
    decision_valid: true,
    status: "ready",
    variance_techniques: varianceTechniques,
    ...overrides,
  };
}

export function statsOutputFixture(overrides: Partial<StatsOutput> = {}): StatsOutput {
  return {
    arm_results: [armResultFixture()],
    srm: {
      srm_p_value: 0.62,
      srm_is_mismatch: false,
      observed_counts: { control: 4_010, treatment: 3_990 },
      expected_counts: { control: 4_000, treatment: 4_000 },
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
      exposure_counts: { control: 4_010, treatment: 3_990 },
      deduped_counts: { control: 4_010, treatment: 3_990 },
      low_n_warning: false,
    },
    ...overrides,
  };
}
