import type {
  DedupeExposureRow,
  CupedAttributeSource,
  CupedCovariateRow,
  CupedMethod,
  MetricKind,
  PerEntityMetricRow,
  VarianceTechniques,
} from "@splitch/contracts";
export type { CupedCovariateRow, CupedCovariateSource } from "@splitch/contracts";

export type MetricVarianceStatus = "ready" | "running" | "insufficient_denominator";

export interface MetricArmEstimateInput {
  readonly run_id: string;
  readonly metric_id: string;
  readonly metric_type: MetricKind;
  readonly variant: string;
  readonly exposures: readonly DedupeExposureRow[];
  readonly metric_values: readonly PerEntityMetricRow[];
}

export interface MetricArmEstimate {
  readonly variant: string;
  readonly metric_id: string;
  readonly metric_type: MetricKind;
  readonly sample_size_n: number;
  readonly point_estimate: number | null;
  readonly sampling_var: number | null;
  readonly status: MetricVarianceStatus;
  readonly arm_variance: number | null;
  readonly denominator_mean: number | null;
  readonly zero_denominator_entity_count: number;
  readonly delta_method: boolean;
  readonly variance_techniques: VarianceTechniques;
}

export interface MetricComparisonEstimateInput {
  readonly run_id: string;
  readonly metric_id: string;
  readonly metric_type: MetricKind;
  readonly control_variant: string;
  readonly treatment_variant: string;
  readonly exposures: readonly DedupeExposureRow[];
  readonly metric_values: readonly PerEntityMetricRow[];
  readonly winsorize?: boolean;
  readonly winsorize_pct?: number;
  readonly cuped?: boolean;
  readonly cuped_coverage_threshold_pct?: number;
  readonly pre_period_covariates?: readonly CupedCovariateRow[];
  /**
   * Set only for a fixed-horizon Run: the pre-registered Entities-per-arm from
   * `sample_size_locked`. Each arm is truncated to its first this-many Entities
   * by exposure time before anything is estimated. Absent means analyze every
   * exposed Entity, which is what a sequential Run does.
   */
  readonly fixed_horizon_sample_size?: number;
}

/**
 * Every arm of one Metric, estimated together.
 *
 * Winsorization pools across all arms and the CUPED fit spans all arms, so the
 * Control arm has one published estimate per Metric rather than one per
 * Treatment it is compared against.
 */
export interface MetricComparisonsEstimateInput
  extends Omit<MetricComparisonEstimateInput, "treatment_variant"> {
  readonly treatment_variants: readonly string[];
}

export interface MetricComparisonsEstimate {
  readonly control: MetricArmEstimate;
  readonly comparisons: readonly MetricComparisonEstimate[];
}

export interface MetricComparisonEstimate {
  readonly metric_id: string;
  readonly metric_type: MetricKind;
  readonly control: MetricArmEstimate;
  readonly treatment: MetricArmEstimate;
  readonly absolute_lift: number | null;
  readonly absolute_lift_sampling_var: number | null;
  /**
   * The two per-arm variances that sum to absolute_lift_sampling_var, after any
   * boundary-safe substitution. A Binomial arm sitting at 0% or 100% has a raw
   * sampling variance of zero, so the substituted value is only recoverable
   * here: rescaling the raw arm variances to the corrected total would leave it
   * at zero.
   */
  readonly absolute_lift_var_components: {
    readonly control: number;
    readonly treatment: number;
  } | null;
  readonly relative_lift_pct: number | null;
  readonly sampling_var: number | null;
  readonly status: MetricVarianceStatus;
  readonly variance_techniques: VarianceTechniques;
}

export interface EntityAggregate {
  targeting_key_hash: string;
  first_exposure_ts: string;
  window_anchor: string;
  value: number;
  num_value: number;
  denom_value: number;
  cuped_adjusted: boolean;
}

export interface CupedAdjustment {
  /** Adjusted entities per arm, positionally aligned with the arms passed in. */
  readonly arms: readonly (readonly EntityAggregate[])[];
  readonly method: CupedMethod;
  readonly attribute: string | null;
  readonly attributeSource: CupedAttributeSource | null;
  readonly coveragePct: number | null;
}
