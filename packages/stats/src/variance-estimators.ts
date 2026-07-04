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

export function estimateMetricComparison(
  input: MetricComparisonEstimateInput,
): MetricComparisonEstimate {
  const controlInput = { ...input, variant: input.control_variant };
  const treatmentInput = { ...input, variant: input.treatment_variant };
  const controlEntities = aggregateEntities(controlInput);
  const treatmentEntities = aggregateEntities(treatmentInput);
  const winsorization = computePooledWinsorization(input, [
    ...controlEntities,
    ...treatmentEntities,
  ]);
  const cuped = applyCupedAdjustment(
    input,
    winsorizedEntities(input.metric_type, controlEntities, winsorization),
    winsorizedEntities(input.metric_type, treatmentEntities, winsorization),
  );
  const varianceTechniques = varianceTechniquesFor(input.metric_type, winsorization, cuped);
  const control = estimateMetricArmFromEntities(
    controlInput,
    cuped.controlEntities,
    varianceTechniques,
  );
  const treatment = estimateMetricArmFromEntities(
    treatmentInput,
    cuped.treatmentEntities,
    varianceTechniques,
  );

  return comparisonEstimate(input, control, treatment, varianceTechniques);
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
