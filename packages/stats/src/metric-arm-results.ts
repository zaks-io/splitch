import type {
  ArmResult,
  DedupeExposureRow,
  MetricKind,
  StatsInput,
  StatsResultStatus,
} from "@splitch/contracts";
import { FixedHorizonCI } from "./fixed-horizon-ci";
import { metricTypesById } from "./metric-discovery";
import { fiellerRelativeCi } from "./relative-ci";
import { SequentialCI, type CIAdapter, type CIResult } from "./sequential-ci";
import { estimateMetricComparison } from "./variance-estimators";
import type { MetricArmEstimate, MetricComparisonEstimate } from "./variance-estimator-types";

export interface ArmResultAdapters {
  readonly sequentialCI: CIAdapter;
  readonly fixedHorizonCI: CIAdapter;
}

export function defaultArmResultAdapters(
  options: Partial<ArmResultAdapters> = {},
): ArmResultAdapters {
  return {
    sequentialCI: options.sequentialCI ?? new SequentialCI(),
    fixedHorizonCI: options.fixedHorizonCI ?? new FixedHorizonCI(),
  };
}

export function analyzeMetricArmResults(
  input: StatsInput,
  exposures: readonly DedupeExposureRow[],
  adapters: ArmResultAdapters,
): ArmResult[] {
  const metricTypes = metricTypesById(input);
  const variants = orderedVariants(input.allocation, input.control_variant);
  const armResults: ArmResult[] = [];

  for (const [metricId, metricType] of metricTypes) {
    const comparisons = variants
      .filter((variant) => variant !== input.control_variant)
      .map((variant) => comparisonFor(input, metricId, metricType, variant, exposures));
    const firstComparison = comparisons[0];
    if (firstComparison === undefined) {
      continue;
    }

    armResults.push(controlArmResult(firstComparison.control));

    for (const comparison of comparisons) {
      armResults.push(treatmentArmResult(input, comparison, adapters));
    }
  }

  return armResults;
}

function orderedVariants(
  allocation: Readonly<Record<string, number>>,
  controlVariant: string,
): string[] {
  const variants = Object.keys(allocation);
  if (!variants.includes(controlVariant)) {
    throw new Error(`control_variant ${controlVariant} is missing from allocation.`);
  }
  if (variants.length < 2) {
    throw new Error("StatsEngine requires at least one Control and one Treatment Variant.");
  }

  return [
    controlVariant,
    ...variants
      .filter((variant) => variant !== controlVariant)
      .sort((left, right) => left.localeCompare(right)),
  ];
}

function comparisonFor(
  input: StatsInput,
  metricId: string,
  metricType: MetricKind,
  treatmentVariant: string,
  exposures: readonly DedupeExposureRow[],
): MetricComparisonEstimate {
  // The Run froze the variance-reduction rule at Start (variance-reduction.md).
  // A Metric absent from the array states no rule, so the estimator's own
  // defaults apply — passing `undefined` is what selects them.
  const variance = input.metric_variance_config?.find((config) => config.metric_id === metricId);
  return estimateMetricComparison({
    run_id: input.run_id,
    metric_id: metricId,
    metric_type: metricType,
    control_variant: input.control_variant,
    treatment_variant: treatmentVariant,
    exposures,
    metric_values: input.metric_values,
    pre_period_covariates: input.pre_period_covariates,
    winsorize: variance?.winsorize,
    winsorize_pct: variance?.winsorize_pct,
    cuped_coverage_threshold_pct: variance?.cuped_coverage_threshold_pct,
  });
}

function controlArmResult(arm: MetricArmEstimate): ArmResult {
  return {
    variant: arm.variant,
    metric_id: arm.metric_id,
    sample_size_n: arm.sample_size_n,
    point_estimate: pointEstimateForOutput(arm),
    relative_lift_pct: null,
    ci_lower: null,
    ci_upper: null,
    p_value: 1,
    is_significant: false,
    in_bh_family: false,
    exploratory: true,
    decision_valid: false,
    status: armStatusForOutput(arm),
    variance_techniques: arm.variance_techniques,
  };
}

function treatmentArmResult(
  input: StatsInput,
  comparison: MetricComparisonEstimate,
  adapters: ArmResultAdapters,
): ArmResult {
  const decisionCi = decisionCiForComparison(input, comparison, adapters);
  const status = treatmentStatusForOutput(comparison, decisionCi);

  return {
    variant: comparison.treatment.variant,
    metric_id: comparison.metric_id,
    sample_size_n: comparison.treatment.sample_size_n,
    point_estimate: pointEstimateForOutput(comparison.treatment),
    relative_lift_pct: relativeLiftForOutput(comparison),
    ci_lower: relativeCiBoundForOutput(comparison, decisionCi, "lower"),
    ci_upper: relativeCiBoundForOutput(comparison, decisionCi, "upper"),
    p_value: decisionCi?.p_value ?? 1,
    is_significant: false,
    in_bh_family: false,
    exploratory: true,
    decision_valid: false,
    status,
    variance_techniques: comparison.variance_techniques,
  };
}

function decisionCiForComparison(
  input: StatsInput,
  comparison: MetricComparisonEstimate,
  adapters: ArmResultAdapters,
): CIResult | null {
  if (
    comparison.control.status !== "ready" ||
    comparison.treatment.status !== "ready" ||
    comparison.absolute_lift === null ||
    comparison.absolute_lift_sampling_var === null
  ) {
    return null;
  }

  const adapter = input.horizon === "fixed" ? adapters.fixedHorizonCI : adapters.sequentialCI;
  return adapter.compute({
    estimate: comparison.absolute_lift,
    sampling_var: comparison.absolute_lift_sampling_var,
    n_t: comparison.treatment.sample_size_n,
    n_c: comparison.control.sample_size_n,
    alpha: 1 - input.confidence_level,
    target_n: input.target_n,
    sample_size_locked: input.sample_size_locked,
  });
}

function treatmentStatusForOutput(
  comparison: MetricComparisonEstimate,
  ci: CIResult | null,
): StatsResultStatus {
  if (comparison.control.sample_size_n === 0 || comparison.treatment.sample_size_n === 0) {
    return "running";
  }
  if (ci === null) {
    if (comparison.status === "insufficient_denominator") {
      return "insufficient_denominator";
    }
    return "running";
  }
  if (ci.status === "error") {
    return "error";
  }
  if (ci.warnings?.some((warning) => warning.code === "FIXED_HORIZON_NOT_AT_LOCKED_SAMPLE")) {
    return "running";
  }
  if (ci.warnings?.some((warning) => warning.code === "ZERO_SAMPLING_VARIANCE")) {
    return comparison.status === "insufficient_denominator"
      ? "insufficient_denominator"
      : "running";
  }
  return "ready";
}

function armStatusForOutput(arm: MetricArmEstimate): StatsResultStatus {
  if (arm.sample_size_n === 0) {
    return "running";
  }
  if (arm.status === "insufficient_denominator") {
    return "insufficient_denominator";
  }
  return "ready";
}

function relativeCiBoundForOutput(
  comparison: MetricComparisonEstimate,
  decisionCi: CIResult | null,
  bound: "lower" | "upper",
): number | null {
  if (comparison.control.sample_size_n === 0 || comparison.treatment.sample_size_n === 0) {
    return bound === "lower" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }
  if (comparison.relative_lift_pct === null || decisionCi === null) {
    return null;
  }

  const bounds = fiellerRelativeCi(comparison, decisionCi);
  return bound === "lower" ? bounds.lower : bounds.upper;
}

function pointEstimateForOutput(arm: MetricArmEstimate): number {
  return arm.point_estimate ?? 0;
}

function relativeLiftForOutput(comparison: MetricComparisonEstimate): number | null {
  const relativeLift = comparison.relative_lift_pct;
  return relativeLift !== null && Number.isFinite(relativeLift) ? relativeLift : null;
}
