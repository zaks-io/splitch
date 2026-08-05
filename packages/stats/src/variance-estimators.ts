import type { MetricKind, PerEntityMetricRow, VarianceTechniques } from "@splitch/contracts";
import { applyCupedAdjustment } from "./cuped";
import { dedupedExposureRowsForVariant } from "./exposure-denominator";
import {
  clampSamplingVariance,
  finiteValue,
  mean,
  sampleCovariance,
  sampleVariance,
} from "./variance-math";
import type {
  EntityAggregate,
  MetricArmEstimate,
  MetricArmEstimateInput,
  MetricComparisonEstimate,
  MetricComparisonEstimateInput,
  MetricComparisonsEstimate,
  MetricComparisonsEstimateInput,
  MetricVarianceStatus,
} from "./variance-estimator-types";
import { comparisonEstimate } from "./variance-effects";
import {
  computePooledWinsorization,
  noVarianceTechniques,
  varianceTechniquesFor,
  winsorizedEntities,
} from "./winsorization";

export function estimateMetricArm(input: MetricArmEstimateInput): MetricArmEstimate {
  const entities = aggregateEntities(input);

  return estimateMetricArmFromEntities(input, entities, noVarianceTechniques(input.metric_type));
}

/**
 * Estimate every arm of one Metric together, then form each Treatment's
 * comparison against the single Control estimate.
 *
 * Winsorization pools over all arms and the CUPED slope is fit over all arms.
 * Scoping either to one (Control, Treatment) pair would make the Control arm's
 * published point estimate depend on which Treatment it happened to be paired
 * with, so renaming a Treatment would move the reported baseline.
 */
export function estimateMetricComparisons(
  input: MetricComparisonsEstimateInput,
): MetricComparisonsEstimate {
  const variants = [input.control_variant, ...input.treatment_variants];
  const entities = variants.map((variant) =>
    lockedSample(aggregateEntities({ ...input, variant }), input.fixed_horizon_sample_size),
  );
  const winsorization = computePooledWinsorization(input, entities.flat());
  const cuped = applyCupedAdjustment(
    input,
    entities.map((armEntities) =>
      winsorizedEntities(input.metric_type, armEntities, winsorization),
    ),
  );
  const varianceTechniques = varianceTechniquesFor(input.metric_type, winsorization, cuped);
  const arms = variants.map((variant, index) => {
    const adjusted = cuped.arms[index];
    if (adjusted === undefined) {
      throw new Error(`CUPED adjustment dropped the arm for Variant ${variant}.`);
    }
    return estimateMetricArmFromEntities({ ...input, variant }, adjusted, varianceTechniques);
  });

  const control = arms[0];
  if (control === undefined) {
    throw new Error("estimateMetricComparisons requires a Control Variant.");
  }

  return {
    control,
    comparisons: input.treatment_variants.map((treatment_variant, index) => {
      const treatment = arms[index + 1];
      if (treatment === undefined) {
        throw new Error(`missing arm estimate for Treatment ${treatment_variant}.`);
      }
      return comparisonEstimate(
        { ...input, treatment_variant },
        control,
        treatment,
        varianceTechniques,
      );
    }),
  };
}

export function estimateMetricComparison(
  input: MetricComparisonEstimateInput,
): MetricComparisonEstimate {
  const { comparisons } = estimateMetricComparisons({
    ...input,
    treatment_variants: [input.treatment_variant],
  });
  const comparison = comparisons[0];
  if (comparison === undefined) {
    throw new Error("estimateMetricComparison produced no comparison.");
  }
  return comparison;
}

function estimateMetricArmFromEntities(
  input: MetricArmEstimateInput,
  entities: readonly EntityAggregate[],
  varianceTechniques: VarianceTechniques,
): MetricArmEstimate {
  const sampleSize = entities.length;

  if (sampleSize === 0) {
    return armEstimate(input, sampleSize, null, null, "running", null, null, 0, varianceTechniques);
  }

  if (input.metric_type === "ratio") {
    return estimateRatioArm(input, entities, varianceTechniques);
  }

  const values = entities.map((entity) => entity.value);
  const pointEstimate = mean(values);
  const armVariance =
    input.metric_type === "binomial" && !entities.some((entity) => entity.cuped_adjusted)
      ? pointEstimate * (1 - pointEstimate)
      : sampleVariance(values);

  return armEstimate(
    input,
    sampleSize,
    pointEstimate,
    armVariance / sampleSize,
    "ready",
    armVariance,
    null,
    0,
    varianceTechniques,
  );
}

function estimateRatioArm(
  input: MetricArmEstimateInput,
  entities: readonly EntityAggregate[],
  varianceTechniques: VarianceTechniques,
): MetricArmEstimate {
  const nums = entities.map((entity) => entity.num_value);
  const denoms = entities.map((entity) => entity.denom_value);
  const sampleSize = entities.length;
  const numeratorMean = mean(nums);
  const denominatorMean = mean(denoms);
  const zeroDenominatorCount = denoms.filter((value) => value === 0).length;

  if (denominatorMean === 0) {
    return armEstimate(
      input,
      sampleSize,
      null,
      null,
      "insufficient_denominator",
      null,
      denominatorMean,
      zeroDenominatorCount,
      varianceTechniques,
    );
  }

  const numeratorVariance = sampleVariance(nums);
  const denominatorVariance = sampleVariance(denoms);
  const covariance = sampleCovariance(nums, denoms);
  const pointEstimate = numeratorMean / denominatorMean;
  const armVariance =
    numeratorVariance / denominatorMean ** 2 -
    (2 * numeratorMean * covariance) / denominatorMean ** 3 +
    (numeratorMean ** 2 * denominatorVariance) / denominatorMean ** 4;

  return armEstimate(
    input,
    sampleSize,
    pointEstimate,
    clampSamplingVariance(armVariance / sampleSize),
    "ready",
    clampSamplingVariance(armVariance),
    denominatorMean,
    zeroDenominatorCount,
    varianceTechniques,
  );
}

function aggregateEntities(input: MetricArmEstimateInput): EntityAggregate[] {
  const entities = seedExposedEntities(input);
  for (const row of metricRowsForInput(input)) {
    const entity = entities.get(row.targeting_key_hash);
    if (!entity) {
      continue;
    }
    applyMetricRow(entity, row, input.metric_type);
  }

  return [...entities.values()];
}

/**
 * Cut a fixed-horizon arm down to the sample the Run pre-registered.
 *
 * A fixed-horizon z-test is decision-valid for exactly `sample_size_locked`
 * Entities per arm, and nothing stops Entities accruing past that: hash-bucketed
 * assignment never lands both arms on the same count, and a Run keeps collecting
 * until someone ends it. Analyzing whatever is present would therefore either
 * never reach the horizon or re-test a growing dataset at every poll, which is
 * peeking on a test that has no peeking correction. Truncating by exposure time
 * makes every re-analysis return the same pre-registered test.
 */
function lockedSample(
  entities: EntityAggregate[],
  sampleSize: number | undefined,
): EntityAggregate[] {
  if (sampleSize === undefined || entities.length <= sampleSize) {
    return entities;
  }
  // Parse each timestamp once rather than twice per comparison.
  return entities
    .map((entity) => ({ entity, ms: exposureMs(entity) }))
    .sort(
      (left, right) =>
        // Entities exposed in the same millisecond still need a total order, or
        // which ones survive truncation would depend on row arrival order.
        left.ms - right.ms ||
        left.entity.targeting_key_hash.localeCompare(right.entity.targeting_key_hash),
    )
    .slice(0, sampleSize)
    .map((keyed) => keyed.entity);
}

function exposureMs(entity: EntityAggregate): number {
  const parsed = Date.parse(entity.first_exposure_ts);
  if (!Number.isFinite(parsed)) {
    throw new Error(`first_exposure_ts must be an ISO timestamp; got ${entity.first_exposure_ts}`);
  }
  return parsed;
}

function seedExposedEntities(input: MetricArmEstimateInput): Map<string, EntityAggregate> {
  const entities = new Map<string, EntityAggregate>();
  for (const exposure of dedupedExposureRowsForVariant(input)) {
    entities.set(exposure.targeting_key_hash, {
      targeting_key_hash: exposure.targeting_key_hash,
      first_exposure_ts: exposure.first_exposure_ts,
      window_anchor: exposure.window_anchor,
      value: 0,
      num_value: 0,
      denom_value: 0,
      cuped_adjusted: false,
    });
  }
  return entities;
}

function metricRowsForInput(input: MetricArmEstimateInput): PerEntityMetricRow[] {
  return input.metric_values.filter((row) => {
    if (row.run_id !== input.run_id || row.metric_id !== input.metric_id || !row.in_window) {
      return false;
    }
    if (row.metric_type !== input.metric_type) {
      throw new Error(
        `metric ${input.metric_id} mixed ${input.metric_type} and ${row.metric_type}`,
      );
    }
    return true;
  });
}

function applyMetricRow(
  entity: EntityAggregate,
  row: PerEntityMetricRow,
  metricType: MetricKind,
): void {
  if (metricType === "ratio") {
    entity.num_value += finiteValue(row.num_value, "num_value");
    entity.denom_value += finiteValue(row.denom_value, "denom_value");
    return;
  }

  if (metricType === "binomial") {
    entity.value = Math.max(entity.value, finiteValue(row.value, "value") > 0 ? 1 : 0);
    return;
  }

  entity.value += finiteValue(row.value, "value");
}

function armEstimate(
  input: MetricArmEstimateInput,
  sample_size_n: number,
  point_estimate: number | null,
  sampling_var: number | null,
  status: MetricVarianceStatus,
  arm_variance: number | null,
  denominator_mean: number | null,
  zero_denominator_entity_count: number,
  variance_techniques: VarianceTechniques,
): MetricArmEstimate {
  return {
    variant: input.variant,
    metric_id: input.metric_id,
    metric_type: input.metric_type,
    sample_size_n,
    point_estimate,
    sampling_var,
    status,
    arm_variance,
    denominator_mean,
    zero_denominator_entity_count,
    delta_method: input.metric_type === "ratio",
    variance_techniques,
  };
}
