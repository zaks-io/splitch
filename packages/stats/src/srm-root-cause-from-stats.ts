import type { StatsOutput } from "@splitch/contracts";
import {
  classifySrmRootCause,
  type SrmRootCauseClassification,
  type SrmRootCauseDayBucket,
  type SrmRootCauseInput,
  type SrmRootCauseSegmentCut,
} from "./srm-root-cause";

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
