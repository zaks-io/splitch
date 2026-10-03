import type {
  CohortEffectBucket,
  CohortEffectBucketId,
  DedupeExposureRow,
  MetricKind,
  StatsInput,
} from "@splitch/contracts";
import type { NoveltyContrastEstimate } from "./cohort-effect-novelty";
import { inverseNormalCdf } from "./normal-distribution";
import { estimateMetricComparison } from "./variance-estimators";

type ContrastEstimate =
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
      kind: "insufficient_denominator";
      nControl: number;
      nTreatment: number;
    };

export function bucketEstimate(args: {
  statsInput: StatsInput;
  metricId: string;
  metricType: MetricKind;
  treatmentVariant: string;
  exposures: readonly DedupeExposureRow[];
  bucket: CohortEffectBucketId;
  minArmN: number;
  alpha: number;
}): CohortEffectBucket {
  const contrast = contrastEstimate(args);
  const nControl =
    contrast?.nControl ?? countVariant(args.exposures, args.statsInput.control_variant);
  const nTreatment = contrast?.nTreatment ?? countVariant(args.exposures, args.treatmentVariant);

  if (contrast === null || nControl < args.minArmN || nTreatment < args.minArmN) {
    return nullEffectBucket(args.bucket, nControl, nTreatment, "insufficient_n");
  }
  if (contrast.kind === "insufficient_denominator") {
    return nullEffectBucket(args.bucket, nControl, nTreatment, "insufficient_denominator");
  }
  if (contrast.kind === "zero_variance") {
    return {
      bucket: args.bucket,
      n_control: nControl,
      n_treatment: nTreatment,
      absolute_effect: contrast.absoluteEffect,
      absolute_ci_lower: null,
      absolute_ci_upper: null,
      status: "zero_variance",
    };
  }

  const interval = fixedHorizonAbsoluteInterval(
    contrast.absoluteEffect,
    contrast.samplingVar,
    args.alpha,
  );
  return {
    bucket: args.bucket,
    n_control: nControl,
    n_treatment: nTreatment,
    absolute_effect: contrast.absoluteEffect,
    absolute_ci_lower: interval.lower,
    absolute_ci_upper: interval.upper,
    status: "ready",
  };
}

/** Novelty only uses positive-variance contrasts — never a zero-variance claim. */
export function noveltyContrast(args: {
  statsInput: StatsInput;
  metricId: string;
  metricType: MetricKind;
  treatmentVariant: string;
  exposures: readonly DedupeExposureRow[];
}): NoveltyContrastEstimate | null {
  const contrast = contrastEstimate(args);
  if (contrast === null || contrast.kind !== "estimated") return null;
  return {
    absoluteEffect: contrast.absoluteEffect,
    samplingVar: contrast.samplingVar,
    nControl: contrast.nControl,
    nTreatment: contrast.nTreatment,
  };
}

function contrastEstimate(args: {
  statsInput: StatsInput;
  metricId: string;
  metricType: MetricKind;
  treatmentVariant: string;
  exposures: readonly DedupeExposureRow[];
}): ContrastEstimate | null {
  if (args.exposures.length === 0) return null;

  // Forward frozen variance-reduction settings exactly as analyzeMetricArmResults does.
  const variance = args.statsInput.metric_variance_config?.find(
    (config) => config.metric_id === args.metricId,
  );
  const comparison = estimateMetricComparison({
    run_id: args.statsInput.run_id,
    metric_id: args.metricId,
    metric_type: args.metricType,
    control_variant: args.statsInput.control_variant,
    treatment_variant: args.treatmentVariant,
    exposures: args.exposures,
    metric_values: args.statsInput.metric_values,
    pre_period_covariates: args.statsInput.pre_period_covariates,
    winsorize: variance?.winsorize,
    winsorize_pct: variance?.winsorize_pct,
    cuped: variance?.cuped,
    cuped_coverage_threshold_pct: variance?.cuped_coverage_threshold_pct,
  });

  const nControl = comparison.control.sample_size_n;
  const nTreatment = comparison.treatment.sample_size_n;
  const absolute = absoluteContrast(
    comparison.absolute_lift,
    comparison.absolute_lift_sampling_var,
  );
  if (absolute !== null) {
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

  if (
    comparison.status === "insufficient_denominator" ||
    comparison.control.status === "insufficient_denominator" ||
    comparison.treatment.status === "insufficient_denominator"
  ) {
    return { kind: "insufficient_denominator", nControl, nTreatment };
  }
  return null;
}

function absoluteContrast(
  absoluteLift: number | null,
  samplingVar: number | null,
): { absoluteEffect: number; samplingVar: number } | null {
  if (
    absoluteLift === null ||
    samplingVar === null ||
    !Number.isFinite(absoluteLift) ||
    !Number.isFinite(samplingVar)
  ) {
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

function countVariant(exposures: readonly DedupeExposureRow[], variant: string): number {
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
