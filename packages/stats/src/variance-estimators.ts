import type { VarianceTechniques } from "@splitch/contracts";
import { applyCupedAdjustment } from "./cuped";
import { reapplyCupedCovariate } from "./cuped-fit";
import { aggregateEntities, lockedSample } from "./entity-aggregation";
import { clampSamplingVariance, mean, sampleCovariance, sampleVariance } from "./variance-math";
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
  cappedEntityCount,
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
  const published = comparisonsFromArms(
    input,
    variants,
    cuped.arms,
    varianceTechniquesFor(input.metric_type, winsorization, cuped),
  );
  if (winsorization === null) {
    return { ...published, winsorized: null };
  }

  // Same Entities, same covariate, no cap: the uncapped estimate differs from
  // the published one only by the truncation it discloses.
  const uncappedCuped = reapplyCupedCovariate(cuped, entities);
  return {
    ...published,
    winsorized: {
      capped_entity_counts: new Map(
        variants.map((variant, index) => [
          variant,
          cappedEntityCount(input.metric_type, armAt(entities, index, variant), winsorization),
        ]),
      ),
      uncapped: comparisonsFromArms(
        input,
        variants,
        uncappedCuped.arms,
        varianceTechniquesFor(input.metric_type, null, uncappedCuped),
      ),
    },
  };
}

function comparisonsFromArms(
  input: MetricComparisonsEstimateInput,
  variants: readonly string[],
  adjustedArms: readonly (readonly EntityAggregate[])[],
  varianceTechniques: VarianceTechniques,
): Omit<MetricComparisonsEstimate, "winsorized"> {
  const arms = variants.map((variant, index) =>
    estimateMetricArmFromEntities(
      { ...input, variant },
      armAt(adjustedArms, index, variant),
      varianceTechniques,
    ),
  );

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

function armAt<T>(arms: readonly T[], index: number, variant: string): T {
  const arm = arms[index];
  if (arm === undefined) {
    throw new Error(`missing arm for Variant ${variant}.`);
  }
  return arm;
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
