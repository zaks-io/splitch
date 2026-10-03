import type {
  CohortEffectBucket,
  CohortEffectBucketId,
  DedupeExposureRow,
  MetricKind,
  StatsInput,
} from "@splitch/contracts";
import type { NoveltyContrastEstimate } from "./cohort-effect-novelty";
import { inverseNormalCdf } from "./normal-distribution";
import type { MetricComparisonEstimate } from "./variance-estimator-types";
import { estimateMetricComparisons } from "./variance-estimators";

export type CohortContrastEstimate =
  | {
      kind: "estimated";
      absoluteEffect: number;
      samplingVar: number;
      nControl: number;
      nTreatment: number;
    }
  | {
      kind: "zero_variance";
      absoluteEffect: number;
      nControl: number;
      nTreatment: number;
    }
  | {
      kind: "numerical_failure";
      absoluteEffect: number;
      nControl: number;
      nTreatment: number;
    }
  | {
      kind: "insufficient_denominator";
      nControl: number;
      nTreatment: number;
    };

/**
 * Fit every allocated arm together for one cohort population (one bucket, or
 * the later-arrivals pool), then project onto each locked-family Treatment.
 *
 * Winsorization and CUPED must span all arms — the same Control baseline the
 * main analysis publishes — so a second Treatment cannot silently change the
 * first Treatment's cohort estimate.
 */
export function contrastsForCohortPopulation(args: {
  statsInput: StatsInput;
  metricId: string;
  metricType: MetricKind;
  allocatedTreatments: readonly string[];
  lockedTreatments: readonly string[];
  exposures: readonly DedupeExposureRow[];
}): Map<string, CohortContrastEstimate | null> {
  const byTreatment = new Map<string, CohortContrastEstimate | null>();
  if (args.exposures.length === 0 || args.allocatedTreatments.length === 0) {
    for (const treatment of args.lockedTreatments) {
      byTreatment.set(treatment, null);
    }
    return byTreatment;
  }

  const variance = args.statsInput.metric_variance_config?.find(
    (config) => config.metric_id === args.metricId,
  );
  const { comparisons } = estimateMetricComparisons({
    run_id: args.statsInput.run_id,
    metric_id: args.metricId,
    metric_type: args.metricType,
    control_variant: args.statsInput.control_variant,
    treatment_variants: args.allocatedTreatments,
    exposures: args.exposures,
    metric_values: args.statsInput.metric_values,
    pre_period_covariates: args.statsInput.pre_period_covariates,
    winsorize: variance?.winsorize,
    winsorize_pct: variance?.winsorize_pct,
    cuped: variance?.cuped,
    cuped_coverage_threshold_pct: variance?.cuped_coverage_threshold_pct,
    data_watermark: args.statsInput.data_watermark,
    metric_retention_horizons: args.statsInput.metric_retention_horizons,
  });

  for (const treatment of args.lockedTreatments) {
    const comparison = comparisons.find((candidate) => candidate.treatment.variant === treatment);
    byTreatment.set(
      treatment,
      comparison === undefined ? null : contrastFromComparison(comparison),
    );
  }
  return byTreatment;
}

export function bucketFromContrast(args: {
  bucket: CohortEffectBucketId;
  contrast: CohortContrastEstimate | null;
  nControlFallback: number;
  nTreatmentFallback: number;
  minArmN: number;
  alpha: number;
}): CohortEffectBucket {
  const nControl = args.contrast?.nControl ?? args.nControlFallback;
  const nTreatment = args.contrast?.nTreatment ?? args.nTreatmentFallback;

  if (args.contrast === null || nControl < args.minArmN || nTreatment < args.minArmN) {
    return nullEffectBucket(args.bucket, nControl, nTreatment, "insufficient_n");
  }
  if (args.contrast.kind === "insufficient_denominator") {
    return nullEffectBucket(args.bucket, nControl, nTreatment, "insufficient_denominator");
  }
  if (args.contrast.kind === "zero_variance") {
    return {
      bucket: args.bucket,
      n_control: nControl,
      n_treatment: nTreatment,
      absolute_effect: args.contrast.absoluteEffect,
      absolute_ci_lower: null,
      absolute_ci_upper: null,
      status: "zero_variance",
    };
  }
  if (args.contrast.kind === "numerical_failure") {
    return {
      bucket: args.bucket,
      n_control: nControl,
      n_treatment: nTreatment,
      absolute_effect: Number.isFinite(args.contrast.absoluteEffect)
        ? args.contrast.absoluteEffect
        : null,
      absolute_ci_lower: null,
      absolute_ci_upper: null,
      status: "numerical_failure",
    };
  }

  const interval = fixedHorizonAbsoluteInterval(
    args.contrast.absoluteEffect,
    args.contrast.samplingVar,
    args.alpha,
  );
  return {
    bucket: args.bucket,
    n_control: nControl,
    n_treatment: nTreatment,
    absolute_effect: args.contrast.absoluteEffect,
    absolute_ci_lower: interval.lower,
    absolute_ci_upper: interval.upper,
    status: "ready",
  };
}

/** Novelty only uses positive-variance contrasts — never a zero-variance claim. */
export function noveltyFromContrast(
  contrast: CohortContrastEstimate | null,
): NoveltyContrastEstimate | null {
  if (contrast === null || contrast.kind !== "estimated") return null;
  return {
    absoluteEffect: contrast.absoluteEffect,
    samplingVar: contrast.samplingVar,
    nControl: contrast.nControl,
    nTreatment: contrast.nTreatment,
  };
}

function contrastFromComparison(
  comparison: MetricComparisonEstimate,
): CohortContrastEstimate | null {
  const nControl = comparison.control.sample_size_n;
  const nTreatment = comparison.treatment.sample_size_n;
  if (hasNonFiniteAbsolute(comparison)) {
    return numericalFailure(comparison.absolute_lift ?? Number.NaN, nControl, nTreatment);
  }
  const absolute = absoluteContrast(
    comparison.absolute_lift,
    comparison.absolute_lift_sampling_var,
  );
  if (absolute !== null) {
    return contrastFromFiniteAbsolute(absolute, nControl, nTreatment);
  }
  if (isInsufficientDenominator(comparison)) {
    return { kind: "insufficient_denominator", nControl, nTreatment };
  }
  return null;
}

function hasNonFiniteAbsolute(comparison: MetricComparisonEstimate): boolean {
  return (
    (comparison.absolute_lift !== null && !Number.isFinite(comparison.absolute_lift)) ||
    (comparison.absolute_lift_sampling_var !== null &&
      !Number.isFinite(comparison.absolute_lift_sampling_var))
  );
}

function isInsufficientDenominator(comparison: MetricComparisonEstimate): boolean {
  return (
    comparison.status === "insufficient_denominator" ||
    comparison.control.status === "insufficient_denominator" ||
    comparison.treatment.status === "insufficient_denominator"
  );
}

function contrastFromFiniteAbsolute(
  absolute: { absoluteEffect: number; samplingVar: number },
  nControl: number,
  nTreatment: number,
): CohortContrastEstimate {
  if (absolute.samplingVar < 0) {
    return numericalFailure(absolute.absoluteEffect, nControl, nTreatment);
  }
  if (!(absolute.samplingVar > 0)) {
    return {
      kind: "zero_variance",
      absoluteEffect: absolute.absoluteEffect,
      nControl,
      nTreatment,
    };
  }
  return {
    kind: "estimated",
    absoluteEffect: absolute.absoluteEffect,
    samplingVar: absolute.samplingVar,
    nControl,
    nTreatment,
  };
}

function numericalFailure(
  absoluteEffect: number,
  nControl: number,
  nTreatment: number,
): CohortContrastEstimate {
  return { kind: "numerical_failure", absoluteEffect, nControl, nTreatment };
}

function absoluteContrast(
  absoluteLift: number | null,
  samplingVar: number | null,
): { absoluteEffect: number; samplingVar: number } | null {
  if (absoluteLift === null || samplingVar === null) {
    return null;
  }
  return { absoluteEffect: absoluteLift, samplingVar };
}

/**
 * Fixed-horizon (one-look) absolute interval at the observed per-bucket n.
 * Not the locked-sample FixedHorizonCI adapter — cohort n is never pre-registered.
 */
export function fixedHorizonAbsoluteInterval(
  estimate: number,
  samplingVar: number,
  alpha: number,
): { lower: number; upper: number } {
  if (!(samplingVar > 0) || !Number.isFinite(samplingVar)) {
    throw new Error(
      `samplingVar must be a positive finite number; received ${String(samplingVar)}.`,
    );
  }
  if (!Number.isFinite(alpha) || !(alpha > 0) || !(alpha < 1)) {
    throw new Error(`alpha must be in (0, 1); received ${String(alpha)}.`);
  }
  const critical = inverseNormalCdf(1 - alpha / 2);
  const boundary = critical * Math.sqrt(samplingVar);
  return { lower: estimate - boundary, upper: estimate + boundary };
}

export function countVariant(exposures: readonly DedupeExposureRow[], variant: string): number {
  return exposures.filter((exposure) => exposure.variant === variant).length;
}

function nullEffectBucket(
  bucket: CohortEffectBucketId,
  nControl: number,
  nTreatment: number,
  status: "insufficient_n" | "insufficient_denominator",
): CohortEffectBucket {
  return {
    bucket,
    n_control: nControl,
    n_treatment: nTreatment,
    absolute_effect: null,
    absolute_ci_lower: null,
    absolute_ci_upper: null,
    status,
  };
}
