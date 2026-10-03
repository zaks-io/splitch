import type {
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
import { bucketEstimate, noveltyContrast } from "./cohort-effect-estimate";
import { classifyCohortNovelty } from "./cohort-effect-novelty";
import {
  COHORT_EFFECT_MIN_ARM_N,
  COHORT_EFFECT_NOVELTY_ALPHA,
  type CohortEffectComputeInput,
} from "./cohort-effect-types";
import { analysisExposureRows } from "./exposure-denominator";
import { metricTypesById } from "./metric-discovery";

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

  // Same Activation-gated denominator the main analysis uses before estimating.
  const analysisExposures = analysisExposureRows({
    run_id: input.statsInput.run_id,
    exposures: input.statsInput.exposures,
    activation_rows: input.statsInput.activation_rows,
  });

  const comparisons = treatments.map((treatmentVariant) =>
    comparisonForTreatment({
      statsInput: input.statsInput,
      analysisExposures,
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
  analysisExposures: readonly DedupeExposureRow[];
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
      exposures: exposuresInBucket(args.analysisExposures, args.runStartedAt, bucket),
      bucket,
    }),
  );

  return {
    treatment_variant: args.treatmentVariant,
    buckets,
    novelty: classifyCohortNovelty({
      earliest: noveltyContrast({
        ...args,
        exposures: exposuresInBucket(args.analysisExposures, args.runStartedAt, "day_0"),
      }),
      laterPooled: noveltyContrast({
        ...args,
        exposures: exposuresInLaterBuckets(args.analysisExposures, args.runStartedAt),
      }),
      alpha: args.alpha,
      minArmN: args.minArmN,
    }),
  };
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

function unavailable(reason: CohortEffectUnavailableReason): UnavailableDiagnostic {
  return { state: "unavailable", reason };
}

function validateRunStartedAt(runStartedAt: string): void {
  if (!Number.isFinite(Date.parse(runStartedAt))) {
    throw new Error(`runStartedAt must be an ISO timestamp; got ${runStartedAt}`);
  }
}
