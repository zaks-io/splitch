import type { ActivationRow, CohortEffectBucketId, DedupeExposureRow } from "@splitch/contracts";
import { COHORT_EFFECT_BUCKET_IDS, MS_PER_DAY } from "./cohort-effect-types";
import { earliestValidActivationTs } from "./srm-activated-arrival";

/**
 * Map an Entity's first_exposure_ts into a day bucket relative to Run start.
 * Day boundaries are UTC calendar-agnostic floor divisions of elapsed ms.
 */
export function exposureDayBucket(
  firstExposureTs: string,
  runStartedAt: string,
): CohortEffectBucketId {
  const exposureMs = timestampMs(firstExposureTs, "first_exposure_ts");
  const startMs = timestampMs(runStartedAt, "runStartedAt");
  if (exposureMs < startMs) {
    throw new Error(
      `first_exposure_ts (${firstExposureTs}) is before Run start (${runStartedAt}).`,
    );
  }
  const day = Math.floor((exposureMs - startMs) / MS_PER_DAY);
  if (day === 0) return "day_0";
  if (day <= 6) return "days_1_6";
  return "day_7_plus";
}

export function exposuresInBucket(
  exposures: readonly DedupeExposureRow[],
  runStartedAt: string,
  bucket: CohortEffectBucketId,
): DedupeExposureRow[] {
  return exposures.filter(
    (exposure) => exposureDayBucket(exposure.first_exposure_ts, runStartedAt) === bucket,
  );
}

/** Later buckets pooled for the novelty contrast (everything after day 0). */
export function exposuresInLaterBuckets(
  exposures: readonly DedupeExposureRow[],
  runStartedAt: string,
): DedupeExposureRow[] {
  return exposures.filter((exposure) => {
    const bucket = exposureDayBucket(exposure.first_exposure_ts, runStartedAt);
    return bucket === "days_1_6" || bucket === "day_7_plus";
  });
}

/**
 * Keep Entities whose Conversion Window has fully elapsed by the analysis
 * watermark. Ungated Runs anchor on first Exposure; gated Runs use the
 * Entity's earliest valid Activation — the same Conversion Window start the
 * main analysis uses. Bucket grouping still uses first Exposure.
 */
export function exposuresWithCompleteOutcomeWindow(
  exposures: readonly DedupeExposureRow[],
  windowDurationMs: number,
  analysisWatermark: string,
  activationsByEntity?: ReadonlyMap<string, readonly ActivationRow[]>,
): DedupeExposureRow[] {
  const watermarkMs = timestampMs(analysisWatermark, "analysisWatermark");
  return exposures.filter((exposure) => {
    const anchorMs =
      activationsByEntity === undefined
        ? timestampMs(exposure.first_exposure_ts, "first_exposure_ts")
        : timestampMs(earliestValidActivationTs(exposure, activationsByEntity), "activation_ts");
    return anchorMs + windowDurationMs <= watermarkMs;
  });
}

export function assertKnownBuckets(): readonly CohortEffectBucketId[] {
  return COHORT_EFFECT_BUCKET_IDS;
}

function timestampMs(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be an ISO timestamp; got ${value}`);
  }
  return parsed;
}
