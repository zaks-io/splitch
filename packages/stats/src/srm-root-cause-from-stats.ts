import type { StatsOutput } from "@splitch/contracts";
import { classifySrmRootCause } from "./srm-root-cause";
import type {
  SrmRootCauseClassification,
  SrmRootCauseDayBucket,
  SrmRootCauseInput,
  SrmRootCauseSegmentCut,
} from "./srm-root-cause-types";

/**
 * Map a ready `StatsOutput` onto the Fabijan classifier. Optional decision-
 * diagnostics slices are passed through when the caller has them; Results
 * alone never invents day or Dimension SRM.
 */
export function srmRootCauseInputFromStats(
  stats: StatsOutput,
  extras: {
    segmentCuts?: readonly SrmRootCauseSegmentCut[];
    dayBuckets?: readonly SrmRootCauseDayBucket[];
  } = {},
): SrmRootCauseInput {
  return {
    exposureMismatch: stats.srm.srm_is_mismatch,
    activatedMismatch: stats.srm.activated_srm_mismatch,
    activationCount: activationCountFromStats(stats),
    ...(extras.segmentCuts !== undefined ? { segmentCuts: extras.segmentCuts } : {}),
    ...(extras.dayBuckets !== undefined ? { dayBuckets: extras.dayBuckets } : {}),
  };
}

export function classifySrmRootCauseFromStats(
  stats: StatsOutput,
  extras: {
    segmentCuts?: readonly SrmRootCauseSegmentCut[];
    dayBuckets?: readonly SrmRootCauseDayBucket[];
  } = {},
): SrmRootCauseClassification | null {
  return classifySrmRootCause(srmRootCauseInputFromStats(stats, extras));
}

/**
 * Reconstruct activated-population size from health rates × deduped Exposure
 * denominators. `null` when there is no Activation gate; `0` when the gate
 * exists and every arm’s Activation rate is zero (fail-closed sentinel).
 */
function activationCountFromStats(stats: StatsOutput): number | null {
  if (stats.srm.activated_srm_mismatch === null) {
    return null;
  }
  const rates = stats.health.activation_rates;
  if (rates === null) {
    return null;
  }
  let total = 0;
  for (const [variant, rate] of Object.entries(rates)) {
    const exposed = stats.health.deduped_counts[variant] ?? 0;
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) {
      throw new Error(
        `activation_rates.${variant} must be a finite non-negative number; received ${JSON.stringify(rate)}.`,
      );
    }
    total += Math.round(rate * exposed);
  }
  return total;
}
