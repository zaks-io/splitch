import type {
  CohortEffectBucketId,
  CohortEffectComparison,
  CohortEffectDiagnostic,
  CohortEffectUnavailableReason,
  DedupeExposureRow,
  StatsInput,
} from "@splitch/contracts";
import {
  assertKnownBuckets,
  exposuresInBucket,
  exposuresInLaterBuckets,
  exposuresWithCompleteOutcomeWindow,
} from "./cohort-effect-buckets";
import {
  bucketFromContrast,
  contrastsForCohortPopulation,
  countVariant,
  noveltyFromContrast,
  type CohortContrastEstimate,
} from "./cohort-effect-estimate";
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

  const lockedTreatments = lockedTreatmentVariants(input.statsInput, primary.metricId);
  if (lockedTreatments.length === 0) {
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
  const completeWindow = completeOutcomeWindowFilter(input, primary.metricId);
  const cohortExposures =
    completeWindow === null
      ? analysisExposures
      : exposuresWithCompleteOutcomeWindow(
          analysisExposures,
          completeWindow.windowDurationMs,
          completeWindow.analysisWatermark,
        );

  const allocatedTreatments = allocatedTreatmentVariants(
    input.statsInput.allocation,
    input.statsInput.control_variant,
  );

  // One all-arm fit per cohort population (each bucket + later pool), then
  // project onto locked-family Treatments — same Control baseline as arm_results.
  const bucketContrasts = assertKnownBuckets().map((bucket) => {
    const exposures = exposuresInBucket(cohortExposures, input.runStartedAt, bucket);
    return {
      bucket,
      exposures,
      contrasts: contrastsForCohortPopulation({
        statsInput: input.statsInput,
        metricId: primary.metricId,
        metricType,
        allocatedTreatments,
        lockedTreatments,
        exposures,
      }),
    };
  });

  const laterExposures = exposuresInLaterBuckets(cohortExposures, input.runStartedAt);
  const laterContrasts = contrastsForCohortPopulation({
    statsInput: input.statsInput,
    metricId: primary.metricId,
    metricType,
    allocatedTreatments,
    lockedTreatments,
    exposures: laterExposures,
  });

  const day0 = bucketContrasts.find((entry) => entry.bucket === "day_0");
  if (day0 === undefined) {
    throw new Error("cohort effect requires a day_0 bucket.");
  }

  const comparisons = lockedTreatments.map((treatmentVariant) =>
    comparisonForTreatment({
      treatmentVariant,
      controlVariant: input.statsInput.control_variant,
      bucketContrasts,
      day0Contrasts: day0.contrasts,
      laterContrasts,
      alpha,
      minArmN,
      noveltyComparable: completeWindow !== null,
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

type BucketContrastEntry = {
  bucket: CohortEffectBucketId;
  exposures: readonly DedupeExposureRow[];
  contrasts: Map<string, CohortContrastEstimate | null>;
};

function comparisonForTreatment(args: {
  treatmentVariant: string;
  controlVariant: string;
  bucketContrasts: readonly BucketContrastEntry[];
  day0Contrasts: Map<string, CohortContrastEstimate | null>;
  laterContrasts: Map<string, CohortContrastEstimate | null>;
  alpha: number;
  minArmN: number;
  noveltyComparable: boolean;
}): CohortEffectComparison {
  const buckets = args.bucketContrasts.map((entry) =>
    bucketFromContrast({
      bucket: entry.bucket,
      contrast: entry.contrasts.get(args.treatmentVariant) ?? null,
      nControlFallback: countVariant(entry.exposures, args.controlVariant),
      nTreatmentFallback: countVariant(entry.exposures, args.treatmentVariant),
      minArmN: args.minArmN,
      alpha: args.alpha,
    }),
  );

  return {
    treatment_variant: args.treatmentVariant,
    buckets,
    novelty: args.noveltyComparable
      ? classifyCohortNovelty({
          earliest: noveltyFromContrast(args.day0Contrasts.get(args.treatmentVariant) ?? null),
          laterPooled: noveltyFromContrast(args.laterContrasts.get(args.treatmentVariant) ?? null),
          alpha: args.alpha,
          minArmN: args.minArmN,
        })
      : { flag: "insufficient_data", alpha: args.alpha },
  };
}

/**
 * Finite Conversion Window plus analysis watermark: novelty and bucket effects
 * compare only Entities whose outcome window is complete. Missing window,
 * missing watermark, or unbounded (`0`) cannot equalize follow-up.
 */
function completeOutcomeWindowFilter(
  input: CohortEffectComputeInput,
  metricId: string,
): { windowDurationMs: number; analysisWatermark: string } | null {
  const windowDurationMs = input.statsInput.metric_conversion_windows?.find(
    (window) => window.metric_id === metricId,
  )?.window_duration_ms;
  if (
    windowDurationMs === undefined ||
    windowDurationMs <= 0 ||
    input.analysisWatermark === undefined
  ) {
    return null;
  }
  return { windowDurationMs, analysisWatermark: input.analysisWatermark };
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

/** Treatments the diagnostic publishes — locked decision family, else allocation. */
function lockedTreatmentVariants(statsInput: StatsInput, metricId: string): string[] {
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
  return allocatedTreatmentVariants(statsInput.allocation, statsInput.control_variant);
}

/** Every allocated Treatment — winsorization / CUPED fit spans these arms. */
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

function unavailable(reason: CohortEffectUnavailableReason): UnavailableDiagnostic {
  return { state: "unavailable", reason };
}

function validateRunStartedAt(runStartedAt: string): void {
  if (!Number.isFinite(Date.parse(runStartedAt))) {
    throw new Error(`runStartedAt must be an ISO timestamp; got ${runStartedAt}`);
  }
}
