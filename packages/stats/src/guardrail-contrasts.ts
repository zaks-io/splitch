import type {
  DedupeExposureRow,
  GuardrailDecision,
  MetricKind,
  StatsInput,
} from "@splitch/contracts";
import { metricTypesById } from "./metric-discovery";
import { estimateMetricComparisons } from "./variance-estimators";
import type { MetricComparisonEstimate } from "./variance-estimator-types";

export type GuardrailContrastKey = `${string}/${string}`;

/**
 * Estimates locked Guardrail Metric × Variant pairs from the same pooled
 * per-Metric pass that ArmResult reporting uses: winsorization and CUPED span
 * every allocated arm, then each Guardrail comparison reuses that estimate.
 * Re-estimating Control+one Treatment alone would publish a different estimand
 * than `arm_results` under multi-Variant winsorization or CUPED.
 */
export function estimateGuardrailContrasts(
  input: StatsInput,
  exposures: readonly DedupeExposureRow[],
): Map<GuardrailContrastKey, MetricComparisonEstimate> {
  const metricTypes = metricTypesById(input);
  const treatmentVariants = allocatedTreatmentVariants(input.allocation, input.control_variant);
  const byKey = new Map<GuardrailContrastKey, MetricComparisonEstimate>();

  for (const [metricId, guardrails] of groupGuardrailsByMetric(input.guardrail_decisions)) {
    fillMetricContrasts(
      byKey,
      input,
      exposures,
      metricId,
      guardrails,
      metricTypes,
      treatmentVariants,
    );
  }

  return byKey;
}

function groupGuardrailsByMetric(
  guardrails: readonly GuardrailDecision[],
): Map<string, GuardrailDecision[]> {
  const byMetric = new Map<string, GuardrailDecision[]>();
  const seen = new Set<GuardrailContrastKey>();

  for (const guardrail of guardrails) {
    const key = contrastKey(guardrail.metric_id, guardrail.variant);
    if (seen.has(key)) {
      throw new Error(`guardrails contains duplicate member ${key}.`);
    }
    seen.add(key);
    const existing = byMetric.get(guardrail.metric_id);
    if (existing === undefined) {
      byMetric.set(guardrail.metric_id, [guardrail]);
    } else {
      existing.push(guardrail);
    }
  }

  return byMetric;
}

function fillMetricContrasts(
  byKey: Map<GuardrailContrastKey, MetricComparisonEstimate>,
  input: StatsInput,
  exposures: readonly DedupeExposureRow[],
  metricId: string,
  guardrails: readonly GuardrailDecision[],
  metricTypes: ReadonlyMap<string, MetricKind>,
  treatmentVariants: readonly string[],
): void {
  const metricType = metricTypes.get(metricId);
  if (metricType === undefined) {
    throw new Error(
      `guardrail metric ${metricId} has no Metric type; Metric values or a locked decision are missing.`,
    );
  }
  const { comparisons } = comparisonsForMetric(
    input,
    exposures,
    metricId,
    metricType,
    treatmentVariants,
  );
  for (const guardrail of guardrails) {
    const comparison = comparisons.find(
      (candidate) => candidate.treatment.variant === guardrail.variant,
    );
    if (comparison === undefined) {
      throw new Error(
        `guardrail ${contrastKey(metricId, guardrail.variant)} has no comparison among allocated arms.`,
      );
    }
    byKey.set(contrastKey(metricId, guardrail.variant), comparison);
  }
}

function comparisonsForMetric(
  input: StatsInput,
  exposures: readonly DedupeExposureRow[],
  metricId: string,
  metricType: MetricKind,
  treatmentVariants: readonly string[],
) {
  const variance = input.metric_variance_config?.find((config) => config.metric_id === metricId);
  return estimateMetricComparisons({
    run_id: input.run_id,
    metric_id: metricId,
    metric_type: metricType,
    control_variant: input.control_variant,
    treatment_variants: treatmentVariants,
    exposures,
    metric_values: input.metric_values,
    pre_period_covariates: input.pre_period_covariates,
    winsorize: variance?.winsorize,
    winsorize_pct: variance?.winsorize_pct,
    cuped: variance?.cuped,
    cuped_coverage_threshold_pct: variance?.cuped_coverage_threshold_pct,
    ...(input.horizon === "fixed" && input.sample_size_locked !== undefined
      ? { fixed_horizon_sample_size: input.sample_size_locked }
      : {}),
  });
}

function allocatedTreatmentVariants(
  allocation: Readonly<Record<string, number>>,
  controlVariant: string,
): string[] {
  const variants = Object.keys(allocation);
  if (!variants.includes(controlVariant)) {
    throw new Error(`control_variant ${controlVariant} is missing from allocation.`);
  }
  return variants
    .filter((variant) => variant !== controlVariant)
    .sort((left, right) => left.localeCompare(right));
}

export function contrastKey(metricId: string, variant: string): GuardrailContrastKey {
  return `${metricId}/${variant}`;
}
