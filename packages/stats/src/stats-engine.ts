import {
  StatsInputSchema,
  StatsOutputSchema,
  type ArmResult,
  type DedupeExposureRow,
  type MetricKind,
  type StatsEngine as StatsEngineContract,
  type StatsInput,
  type StatsOutput,
  type StatsResultStatus,
} from "@splitch/contracts";
import { applyDecisionFamilyCorrection } from "./decision-family-fdr.js";
import { analysisExposureRows } from "./exposure-denominator.js";
import { FixedHorizonCI } from "./fixed-horizon-ci.js";
import { applyGuardrailBoundChecks } from "./guardrail-bound-check.js";
import { metricTypesById } from "./metric-discovery.js";
import { SequentialCI, type CIAdapter, type CIResult } from "./sequential-ci.js";
import { checkSrmHealth } from "./srm-checker.js";
import { estimateMetricComparison } from "./variance-estimators.js";
import type { MetricArmEstimate, MetricComparisonEstimate } from "./variance-estimator-types.js";

export interface StatsEngineOptions {
  readonly sequentialCI?: CIAdapter;
  readonly fixedHorizonCI?: CIAdapter;
}

export const StatsEngine = {
  analyze: analyzeStats,
} satisfies StatsEngineContract;

export async function analyzeStats(
  rawInput: StatsInput,
  options: StatsEngineOptions = {},
): Promise<StatsOutput> {
  const input = StatsInputSchema.parse(rawInput);
  validateLockedRunInput(input);

  const { srm, health } = checkSrmHealth({
    run_id: input.run_id,
    allocation: input.allocation,
    exposures: input.exposures,
    activation_rows: input.activation_rows,
  });
  const armResults = analyzeMetrics(input, {
    sequentialCI: options.sequentialCI ?? new SequentialCI(),
    fixedHorizonCI: options.fixedHorizonCI ?? new FixedHorizonCI(),
  });
  const guardrailResults = applyGuardrailBoundChecks({
    arm_results: armResults,
    guardrails: input.guardrail_decisions,
  });
  const corrected = applyDecisionFamilyCorrection({
    arm_results: armResults,
    decision_family: input.decision_family,
    confidence_level: input.confidence_level,
    control_variant: input.control_variant,
  });

  return StatsOutputSchema.parse({
    arm_results: corrected.arm_results,
    srm,
    guardrail_results: guardrailResults,
    health,
  });
}

function analyzeMetrics(input: StatsInput, adapters: Required<StatsEngineOptions>): ArmResult[] {
  const metricTypes = metricTypesById(input);
  const variants = orderedVariants(input.allocation, input.control_variant);
  const exposures = analysisExposureRows({
    run_id: input.run_id,
    exposures: input.exposures,
    activation_rows: input.activation_rows,
  });
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
  return estimateMetricComparison({
    run_id: input.run_id,
    metric_id: metricId,
    metric_type: metricType,
    control_variant: input.control_variant,
    treatment_variant: treatmentVariant,
    exposures,
    metric_values: input.metric_values,
    pre_period_covariates: input.pre_period_covariates,
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
  adapters: Required<StatsEngineOptions>,
): ArmResult {
  const ci = ciForComparison(input, comparison, adapters);
  const status = treatmentStatusForOutput(comparison, ci);

  return {
    variant: comparison.treatment.variant,
    metric_id: comparison.metric_id,
    sample_size_n: comparison.treatment.sample_size_n,
    point_estimate: pointEstimateForOutput(comparison.treatment),
    relative_lift_pct: relativeLiftForOutput(comparison),
    ci_lower: ciLowerForOutput(comparison, ci),
    ci_upper: ciUpperForOutput(comparison, ci),
    p_value: ci?.p_value ?? 1,
    is_significant: false,
    in_bh_family: false,
    exploratory: true,
    decision_valid: false,
    status,
    variance_techniques: comparison.variance_techniques,
  };
}

function ciForComparison(
  input: StatsInput,
  comparison: MetricComparisonEstimate,
  adapters: Required<StatsEngineOptions>,
): CIResult | null {
  if (
    comparison.status !== "ready" ||
    comparison.relative_lift_pct === null ||
    comparison.sampling_var === null
  ) {
    return null;
  }

  const adapter = input.horizon === "fixed" ? adapters.fixedHorizonCI : adapters.sequentialCI;
  return adapter.compute({
    estimate: comparison.relative_lift_pct,
    sampling_var: comparison.sampling_var,
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
  if (comparison.status === "insufficient_denominator") {
    return "insufficient_denominator";
  }
  if (comparison.status !== "ready" || ci === null) {
    return "running";
  }
  if (ci.status === "error") {
    return "error";
  }
  if (ci.warnings?.some((warning) => warning.code === "FIXED_HORIZON_NOT_AT_LOCKED_SAMPLE")) {
    return "running";
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

function ciLowerForOutput(
  comparison: MetricComparisonEstimate,
  ci: CIResult | null,
): number | null {
  if (ci !== null) {
    return ci.ci_lower;
  }
  if (comparison.control.sample_size_n === 0 || comparison.treatment.sample_size_n === 0) {
    return Number.NEGATIVE_INFINITY;
  }
  return null;
}

function ciUpperForOutput(
  comparison: MetricComparisonEstimate,
  ci: CIResult | null,
): number | null {
  if (ci !== null) {
    return ci.ci_upper;
  }
  if (comparison.control.sample_size_n === 0 || comparison.treatment.sample_size_n === 0) {
    return Number.POSITIVE_INFINITY;
  }
  return null;
}

function pointEstimateForOutput(arm: MetricArmEstimate): number {
  return arm.point_estimate ?? 0;
}

function relativeLiftForOutput(comparison: MetricComparisonEstimate): number | null {
  const relativeLift = comparison.relative_lift_pct;
  return relativeLift !== null && Number.isFinite(relativeLift) ? relativeLift : null;
}

function validateLockedRunInput(input: StatsInput): void {
  if (input.horizon === "fixed" && input.sample_size_locked === undefined) {
    throw new Error("fixed horizon requires sample_size_locked from the locked Run input.");
  }
  if (input.horizon === "fixed" && input.target_n !== undefined) {
    throw new Error("target_n is only valid when the locked Run horizon is sequential.");
  }
  if (input.horizon === "sequential" && input.sample_size_locked !== undefined) {
    throw new Error("sample_size_locked is only valid when the locked Run horizon is fixed.");
  }
}
