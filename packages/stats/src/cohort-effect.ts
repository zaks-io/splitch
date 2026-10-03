import type {
  CohortEffectBucket,
  CohortEffectBucketId,
  CohortEffectComparison,
  CohortEffectDiagnostic,
  CohortEffectUnavailableReason,
  DedupeExposureRow,
  MetricKind,
  StatsInput,
} from "@splitch/contracts";
import {
  assertKnownBuckets,
  exposuresInBucket,
  exposuresInLaterBuckets,
} from "./cohort-effect-buckets";
import { classifyCohortNovelty, type NoveltyContrastEstimate } from "./cohort-effect-novelty";
import {
  COHORT_EFFECT_MIN_ARM_N,
  COHORT_EFFECT_NOVELTY_ALPHA,
  type CohortEffectComputeInput,
} from "./cohort-effect-types";
import { metricTypesById } from "./metric-discovery";
import { inverseNormalCdf } from "./normal-distribution";
import { estimateMetricComparison } from "./variance-estimators";

/**
 * Effect by first-exposure-day bucket for the primary Metric, plus a novelty
 * flag when day-0 differs from later arrivals beyond noise (plan 2.8).
 *
 * Never part of the decision, the gate, or the result token.
 */
export function computeCohortEffect(input: CohortEffectComputeInput): CohortEffectDiagnostic {
  const alpha = input.noveltyAlpha ?? COHORT_EFFECT_NOVELTY_ALPHA;
  const minArmN = input.minArmN ?? COHORT_EFFECT_MIN_ARM_N;
  validateRunStartedAt(input.runStartedAt);

  const primary = resolvePrimaryMetric(input.statsInput);
  if (primary.state === "unavailable") return primary;

  const treatments = treatmentVariants(input.statsInput, primary.metricId);
  if (treatments.length === 0) {
    return unavailable("no_treatment_variant");
  }

  const metricType = metricTypesById(input.statsInput).get(primary.metricId);
  if (metricType === undefined) {
    return unavailable("insufficient_entities");
  }

  const comparisons = treatments.map((treatmentVariant) =>
    comparisonForTreatment({
      statsInput: input.statsInput,
      runStartedAt: input.runStartedAt,
      metricId: primary.metricId,
      metricType,
      treatmentVariant,
      alpha,
      minArmN,
    }),
  );

  const anyEntities = comparisons.some((comparison) =>
    comparison.buckets.some((bucket) => bucket.n_control + bucket.n_treatment > 0),
  );
  if (!anyEntities) {
    return unavailable("insufficient_entities");
  }

  return {
    state: "ready",
    metric_id: primary.metricId,
    grouping: "first_exposure_day_vs_run_start",
    comparisons,
  };
}

function comparisonForTreatment(args: {
  statsInput: StatsInput;
  runStartedAt: string;
  metricId: string;
  metricType: MetricKind;
  treatmentVariant: string;
  alpha: number;
  minArmN: number;
}): CohortEffectComparison {
  const buckets = assertKnownBuckets().map((bucket) =>
    bucketEstimate({
      ...args,
      exposures: exposuresInBucket(args.statsInput.exposures, args.runStartedAt, bucket),
      bucket,
    }),
  );

  const earliest = contrastEstimate({
    ...args,
    exposures: exposuresInBucket(args.statsInput.exposures, args.runStartedAt, "day_0"),
  });
  const laterPooled = contrastEstimate({
    ...args,
    exposures: exposuresInLaterBuckets(args.statsInput.exposures, args.runStartedAt),
  });

  return {
    treatment_variant: args.treatmentVariant,
    buckets,
    novelty: classifyCohortNovelty({
      earliest,
      laterPooled,
      alpha: args.alpha,
      minArmN: args.minArmN,
    }),
  };
}

function bucketEstimate(args: {
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
  if (contrast === null || contrast.nControl < args.minArmN || contrast.nTreatment < args.minArmN) {
    return {
      bucket: args.bucket,
      n_control:
        contrast?.nControl ?? countVariant(args.exposures, args.statsInput.control_variant),
      n_treatment: contrast?.nTreatment ?? countVariant(args.exposures, args.treatmentVariant),
      absolute_effect: null,
      absolute_ci_lower: null,
      absolute_ci_upper: null,
      status: "insufficient_n",
    };
  }

  const interval = fixedHorizonAbsoluteInterval(
    contrast.absoluteEffect,
    contrast.samplingVar,
    args.alpha,
  );
  return {
    bucket: args.bucket,
    n_control: contrast.nControl,
    n_treatment: contrast.nTreatment,
    absolute_effect: contrast.absoluteEffect,
    absolute_ci_lower: interval.lower,
    absolute_ci_upper: interval.upper,
    status: "ready",
  };
}

function contrastEstimate(args: {
  statsInput: StatsInput;
  metricId: string;
  metricType: MetricKind;
  treatmentVariant: string;
  exposures: readonly DedupeExposureRow[];
}): NoveltyContrastEstimate | null {
  if (args.exposures.length === 0) return null;
  const comparison = estimateMetricComparison({
    run_id: args.statsInput.run_id,
    metric_id: args.metricId,
    metric_type: args.metricType,
    control_variant: args.statsInput.control_variant,
    treatment_variant: args.treatmentVariant,
    exposures: args.exposures,
    metric_values: args.statsInput.metric_values,
  });
  if (
    comparison.absolute_lift === null ||
    comparison.absolute_lift_sampling_var === null ||
    !Number.isFinite(comparison.absolute_lift) ||
    !Number.isFinite(comparison.absolute_lift_sampling_var)
  ) {
    return null;
  }
  return {
    absoluteEffect: comparison.absolute_lift,
    samplingVar: comparison.absolute_lift_sampling_var,
    nControl: comparison.control.sample_size_n,
    nTreatment: comparison.treatment.sample_size_n,
  };
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

type UnavailableDiagnostic = {
  state: "unavailable";
  reason: CohortEffectUnavailableReason;
};

function resolvePrimaryMetric(
  statsInput: StatsInput,
): { state: "ready"; metricId: string } | UnavailableDiagnostic {
  const fromPreReg = statsInput.pre_registration?.primary_metric_id;
  if (fromPreReg !== undefined) {
    return { state: "ready", metricId: fromPreReg };
  }
  const fromFamily = [
    ...new Set(
      statsInput.decision_family
        .filter((member) => member.dimension_id == null)
        .map((member) => member.metric_id),
    ),
  ];
  if (fromFamily.length === 0) return unavailable("no_primary_metric");
  if (fromFamily.length > 1) return unavailable("ambiguous_primary_metric");
  const only = fromFamily[0];
  if (only === undefined) return unavailable("no_primary_metric");
  return { state: "ready", metricId: only };
}

function treatmentVariants(statsInput: StatsInput, metricId: string): string[] {
  const fromFamily = [
    ...new Set(
      statsInput.decision_family
        .filter(
          (member) =>
            member.metric_id === metricId &&
            member.dimension_id == null &&
            member.variant !== statsInput.control_variant,
        )
        .map((member) => member.variant),
    ),
  ];
  if (fromFamily.length > 0) return fromFamily.sort((a, b) => a.localeCompare(b));
  return Object.keys(statsInput.allocation)
    .filter((variant) => variant !== statsInput.control_variant)
    .sort((a, b) => a.localeCompare(b));
}

function countVariant(exposures: readonly DedupeExposureRow[], variant: string): number {
  return exposures.filter((exposure) => exposure.variant === variant).length;
}

function unavailable(reason: CohortEffectUnavailableReason): UnavailableDiagnostic {
  return { state: "unavailable", reason };
}

function validateRunStartedAt(runStartedAt: string): void {
  if (!Number.isFinite(Date.parse(runStartedAt))) {
    throw new Error(`runStartedAt must be an ISO timestamp; got ${runStartedAt}`);
  }
}
