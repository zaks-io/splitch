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
  readonly cuped_coverage_threshold?: number;
  readonly pre_period_covariates?: readonly CupedCovariateRow[];
}

export interface MetricComparisonEstimate {
  readonly metric_id: string;
  readonly metric_type: MetricKind;
  readonly control: MetricArmEstimate;
  readonly treatment: MetricArmEstimate;
  readonly absolute_lift: number | null;
  readonly absolute_lift_sampling_var: number | null;
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
  readonly controlEntities: readonly EntityAggregate[];
  readonly treatmentEntities: readonly EntityAggregate[];
  readonly method: CupedMethod;
  readonly attribute: string | null;
  readonly attributeSource: CupedAttributeSource | null;
  readonly coveragePct: number | null;
}
