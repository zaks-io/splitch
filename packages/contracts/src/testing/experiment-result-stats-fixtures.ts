import type { ArmResult } from "../stats-result-arm";
import type { StatsOutput } from "../stats-result-contract";
import { StatsOutputSchema } from "../stats-result-contract";

export function statsFixture(overrides: Partial<StatsOutput> = {}): StatsOutput {
  return StatsOutputSchema.parse({
    arm_results: [
      {
        variant: "treatment",
        metric_id: "checkout_conversion",
        sample_size_n: 12_480,
        point_estimate: 0.184,
        relative_lift_pct: 6.4,
        ci_lower: 1.9,
        ci_upper: 11.2,
        p_value: 0.0041,
        is_significant: true,
        in_bh_family: true,
        exploratory: false,
        decision_valid: true,
        status: "ready",
        variance_techniques: varianceTechniques(),
      },
    ],
    srm: {
      srm_p_value: 0.62,
      srm_is_mismatch: false,
      observed_counts: { control: 12_530, treatment: 12_480 },
      expected_counts: { control: 12_505, treatment: 12_505 },
      activated_srm_p_value: null,
      activated_srm_mismatch: null,
    },
    guardrail_results: [
      {
        metric_id: "checkout_latency_p95",
        variant: "treatment",
        ci_lower: -3.2,
        threshold: -10,
        is_breached: false,
        in_bh_family: false,
        exploratory: false,
        decision_valid: true,
        breach_reason: null,
      },
    ],
    health: {
      multiple_rate: 0.0012,
      multiple_count: 30,
      activation_rates: null,
      activation_balance_p_value: null,
      activation_balance_mismatch: null,
      exposure_counts: { control: 12_560, treatment: 12_510 },
      deduped_counts: { control: 12_530, treatment: 12_480 },
      low_n_warning: false,
    },
    ...overrides,
  });
}

export function statsWithAnalysisControl(analysisControl = "control"): StatsOutput {
  const base = statsFixture();
  const [treatmentResult] = base.arm_results;
  if (!treatmentResult) throw new Error("statsFixture must produce one Treatment result");
  return StatsOutputSchema.parse({
    ...base,
    arm_results: [analysisControlArmResult(treatmentResult, analysisControl), treatmentResult],
  });
}

export function controlDisagreementStats(): StatsOutput {
  const base = statsWithAnalysisControl("legacy_checkout");
  const [analysisControlResult, treatmentResult] = base.arm_results;
  if (!analysisControlResult || !treatmentResult) {
    throw new Error("statsWithAnalysisControl must produce Control and Treatment results");
  }
  return StatsOutputSchema.parse({
    ...base,
    arm_results: [analysisControlResult, { ...treatmentResult, variant: "control" }],
    srm: {
      ...base.srm,
      observed_counts: { legacy_checkout: 12_530, control: 12_480 },
      expected_counts: { legacy_checkout: 12_505, control: 12_505 },
    },
    health: {
      ...base.health,
      exposure_counts: { legacy_checkout: 12_560, control: 12_510 },
      deduped_counts: { legacy_checkout: 12_530, control: 12_480 },
    },
  });
}

function analysisControlArmResult(template: ArmResult, variant: string): ArmResult {
  return {
    ...template,
    variant,
    sample_size_n: 12_530,
    relative_lift_pct: null,
    ci_lower: null,
    ci_upper: null,
    p_value: 1,
    is_significant: false,
    in_bh_family: false,
    exploratory: true,
    decision_valid: false,
  };
}

export function srmFiringStats(): StatsOutput {
  const base = statsFixture();
  return StatsOutputSchema.parse({
    ...base,
    srm: {
      ...base.srm,
      srm_p_value: 0.00002,
      srm_is_mismatch: true,
      observed_counts: { control: 14_900, treatment: 10_110 },
    },
  });
}

export function underpoweredStats(): StatsOutput {
  const base = statsFixture();
  const [arm] = base.arm_results;
  if (!arm) throw new Error("statsFixture must produce one arm result");
  return StatsOutputSchema.parse({
    ...base,
    arm_results: [
      {
        ...arm,
        sample_size_n: 61,
        relative_lift_pct: 18.2,
        ci_lower: -9.4,
        ci_upper: 52.1,
        p_value: 0.31,
        is_significant: false,
        status: "insufficient_n",
      },
    ],
    health: { ...base.health, low_n_warning: true },
  });
}

export function breachedGuardrailStats(): StatsOutput {
  const base = statsFixture();
  return StatsOutputSchema.parse({
    ...base,
    guardrail_results: [
      {
        metric_id: "checkout_latency_p95",
        variant: "treatment",
        ci_lower: -24.6,
        threshold: -10,
        is_breached: true,
        in_bh_family: false,
        exploratory: false,
        decision_valid: true,
        breach_reason: "CI lower bound is below the locked downside threshold",
      },
    ],
  });
}

export function modestLiftStats(): StatsOutput {
  const base = statsFixture();
  const [arm] = base.arm_results;
  if (!arm) throw new Error("statsFixture must produce one arm result");
  return StatsOutputSchema.parse({
    ...base,
    arm_results: [
      {
        ...arm,
        sample_size_n: 48_210,
        point_estimate: 0.1863,
        relative_lift_pct: 2.4,
        ci_lower: 0.6,
        ci_upper: 4.2,
        p_value: 0.0092,
      },
    ],
  });
}

function varianceTechniques() {
  return {
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
}
