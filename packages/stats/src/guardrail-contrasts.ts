import type { DedupeExposureRow, MetricKind, StatsInput } from "@splitch/contracts";
import { metricTypesById } from "./metric-discovery";
import { estimateMetricComparison } from "./variance-estimators";
import type { MetricComparisonEstimate } from "./variance-estimator-types";

export type GuardrailContrastKey = `${string}/${string}`;

/**
 * Re-estimates only the locked Guardrail Metric × Variant pairs so the
 * analysis-v2 one-sided contrast path can read arm means and variance
 * components without changing the ArmResult reporting shape (Fieller stays on
 * arm_results for every analysis_version).
 */
export function estimateGuardrailContrasts(
  input: StatsInput,
  exposures: readonly DedupeExposureRow[],
): Map<GuardrailContrastKey, MetricComparisonEstimate> {
  const metricTypes = metricTypesById(input);
  const byKey = new Map<GuardrailContrastKey, MetricComparisonEstimate>();

  for (const guardrail of input.guardrail_decisions) {
    const key = contrastKey(guardrail.metric_id, guardrail.variant);
    if (byKey.has(key)) {
      throw new Error(`guardrails contains duplicate member ${key}.`);
    }
    const metricType = metricTypes.get(guardrail.metric_id);
    if (metricType === undefined) {
      throw new Error(
        `guardrail ${key} has no Metric type; Metric values or a locked decision are missing.`,
      );
    }
    byKey.set(
      key,
      comparisonForGuardrail(input, exposures, guardrail.metric_id, metricType, guardrail.variant),
    );
  }

  return byKey;
}

function comparisonForGuardrail(
  input: StatsInput,
  exposures: readonly DedupeExposureRow[],
  metricId: string,
  metricType: MetricKind,
  treatmentVariant: string,
): MetricComparisonEstimate {
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
    cuped: variance?.cuped,
    cuped_coverage_threshold_pct: variance?.cuped_coverage_threshold_pct,
    ...(input.horizon === "fixed" && input.sample_size_locked !== undefined
      ? { fixed_horizon_sample_size: input.sample_size_locked }
      : {}),
  });
}

export function contrastKey(metricId: string, variant: string): GuardrailContrastKey {
  return `${metricId}/${variant}`;
}
