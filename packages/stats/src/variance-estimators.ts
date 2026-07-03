import type { MetricKind, PerEntityMetricRow } from "@splitch/contracts";
import {
  clampSamplingVariance,
  finiteValue,
  mean,
  sampleCovariance,
  sampleVariance,
} from "./variance-math.js";
import type {
  EntityAggregate,
  MetricArmEstimate,
  MetricArmEstimateInput,
  MetricComparisonEstimate,
  MetricComparisonEstimateInput,
  MetricVarianceStatus,
} from "./variance-estimator-types.js";

export function estimateMetricArm(input: MetricArmEstimateInput): MetricArmEstimate {
  const entities = aggregateEntities(input);
  const sampleSize = entities.length;

  if (sampleSize === 0) {
    return armEstimate(input, sampleSize, null, null, "running", null, null, 0);
  }

  if (input.metric_type === "ratio") {
    return estimateRatioArm(input, entities);
  }

  const values = entities.map((entity) => entity.value);
  const pointEstimate = mean(values);
  const armVariance =
    input.metric_type === "binomial" ? pointEstimate * (1 - pointEstimate) : sampleVariance(values);

  return armEstimate(
    input,
    sampleSize,
    pointEstimate,
    armVariance / sampleSize,
    "ready",
    armVariance,
    null,
    0,
  );
}

export function estimateMetricComparison(
  input: MetricComparisonEstimateInput,
): MetricComparisonEstimate {
  const control = estimateMetricArm({ ...input, variant: input.control_variant });
  const treatment = estimateMetricArm({ ...input, variant: input.treatment_variant });

  return comparisonEstimate(input, control, treatment, {
    ...absoluteLiftEffect(control, treatment),
    ...relativeLiftEffect(control, treatment),
  });
}

function estimateRatioArm(
  input: MetricArmEstimateInput,
  entities: readonly EntityAggregate[],
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
  for (const exposure of input.exposures) {
    if (exposure.run_id === input.run_id && exposure.variant === input.variant) {
      entities.set(exposure.targeting_key_hash, { value: 0, num_value: 0, denom_value: 0 });
    }
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
  };
}

function comparisonEstimate(
  input: MetricComparisonEstimateInput,
  control: MetricArmEstimate,
  treatment: MetricArmEstimate,
  effect: Pick<
    MetricComparisonEstimate,
    "absolute_lift" | "absolute_lift_sampling_var" | "relative_lift_pct" | "sampling_var" | "status"
  >,
): MetricComparisonEstimate {
  return {
    metric_id: input.metric_id,
    metric_type: input.metric_type,
    control,
    treatment,
    ...effect,
  };
}

function absoluteLiftEffect(
  control: MetricArmEstimate,
  treatment: MetricArmEstimate,
): Pick<MetricComparisonEstimate, "absolute_lift" | "absolute_lift_sampling_var"> {
  return {
    absolute_lift:
      treatment.point_estimate === null || control.point_estimate === null
        ? null
        : treatment.point_estimate - control.point_estimate,
    absolute_lift_sampling_var:
      treatment.sampling_var === null || control.sampling_var === null
        ? null
        : treatment.sampling_var + control.sampling_var,
  };
}

function relativeLiftEffect(
  control: MetricArmEstimate,
  treatment: MetricArmEstimate,
): Pick<MetricComparisonEstimate, "relative_lift_pct" | "sampling_var" | "status"> {
  if (control.status !== "ready" || treatment.status !== "ready") {
    return {
      relative_lift_pct: null,
      sampling_var: null,
      status:
        control.status === "insufficient_denominator" ||
        treatment.status === "insufficient_denominator"
          ? "insufficient_denominator"
          : "running",
    };
  }

  const values = readyRelativeValues(control, treatment);
  if (!values || values.controlPoint === 0) {
    return { relative_lift_pct: null, sampling_var: null, status: "insufficient_denominator" };
  }

  const relativeLift = values.treatmentPoint / values.controlPoint - 1;
  const samplingVar =
    (values.treatmentSamplingVar / values.controlPoint ** 2 +
      (values.treatmentPoint ** 2 * values.controlSamplingVar) / values.controlPoint ** 4) *
    10_000;

  return {
    relative_lift_pct: relativeLift * 100,
    sampling_var: clampSamplingVariance(samplingVar),
    status: "ready",
  };
}

function readyRelativeValues(control: MetricArmEstimate, treatment: MetricArmEstimate) {
  const controlPoint = control.point_estimate;
  const treatmentPoint = treatment.point_estimate;
  const controlSamplingVar = control.sampling_var;
  const treatmentSamplingVar = treatment.sampling_var;

  if (
    controlPoint === null ||
    treatmentPoint === null ||
    controlSamplingVar === null ||
    treatmentSamplingVar === null
  ) {
    return null;
  }

  return { controlPoint, treatmentPoint, controlSamplingVar, treatmentSamplingVar };
}
