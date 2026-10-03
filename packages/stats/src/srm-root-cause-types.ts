/**
 * Shared types and constants for the Fabijan et al. 2019 SRM root-cause
 * classifier. Classification lives in `srm-root-cause.ts`.
 */

export const SRM_ROOT_CAUSE_BRANCHES = [
  "triggered_only",
  "segment_localized",
  "day_one",
  "unclassified",
] as const;

export type SrmRootCauseBranch = (typeof SRM_ROOT_CAUSE_BRANCHES)[number];

/**
 * Stated alpha for "slice imbalances differ beyond noise" (chi-square
 * homogeneity across Dimension cuts). Matches the SRM mismatch alpha so
 * localization is not claimed from volume-only significance differences.
 */
export const SRM_ROOT_CAUSE_SEGMENT_HOMOGENEITY_ALPHA = 0.001;

/** Branches Fabijan describes that this classifier cannot judge today. */
export const SRM_ROOT_CAUSE_TELEMETRY_GAPS = [
  {
    branch: "engagement_direction",
    needed:
      "Per-Variant engagement or activity intensity among Exposed Entities before the SRM window closes.",
  },
  {
    branch: "latency_linked",
    needed:
      "Per-Variant Exposure or Assignment logging latency distributions tied to the same denominator.",
  },
] as const;

export interface SrmRootCauseSegmentCut {
  readonly dimensionId: string;
  readonly dimensionValue: string;
  readonly srmIsMismatch: boolean;
  /**
   * Per-Variant observed counts for this slice. Required to claim
   * `segment_localized`; without counts the classifier can only report which
   * slices crossed the SRM threshold.
   */
  readonly observedCounts?: Readonly<Record<string, number>>;
}

/**
 * First-Exposure calendar-day (or equivalent) arm counts already scored for
 * SRM. Buckets must be ordered earliest-first; this function does not sort.
 */
export interface SrmRootCauseDayBucket {
  readonly day: string;
  readonly srmIsMismatch: boolean;
}

export interface SrmRootCauseInput {
  readonly exposureMismatch: boolean;
  /** `null` when the Run has no Activation gate. */
  readonly activatedMismatch: boolean | null;
  /**
   * Total activated-population size when an Activation gate exists.
   * `null` when there is no gate (or the count was not supplied).
   * `0` means the checker’s fail-closed zero-Activation sentinel — not
   * evidence of Activation-driven imbalance.
   */
  readonly activationCount: number | null;
  /**
   * Dimension / Segment auto-cuts from decision-diagnostics. Omit when the
   * producer has not fetched them; an empty list means cuts were fetched and
   * none exist.
   */
  readonly segmentCuts?: readonly SrmRootCauseSegmentCut[];
  /**
   * Per first-Exposure-day SRM scores. Omit when trend buckets are unavailable;
   * an empty list means the range was fetched and is empty.
   */
  readonly dayBuckets?: readonly SrmRootCauseDayBucket[];
}

/** Canonical operation id every branch's `nextCheck` must resolve to today. */
export const SRM_ROOT_CAUSE_NEXT_CHECK = "experiment_results_get" as const;

export interface SrmRootCauseClassification {
  readonly branch: SrmRootCauseBranch;
  readonly explanation: string;
  /**
   * Canonical `routeRegistry` operationId the operator/agent should call next.
   * Must resolve via `getRoute` — never a future/spec-only path name.
   */
  readonly nextCheck: string;
  /** Set on `unclassified`: every signal the classifier weighed. */
  readonly evidenceConsidered?: string[];
}

/** Internal matched Fabijan branch before conflict resolution. */
export interface SrmRootCauseMatchedBranch {
  readonly branch: Exclude<SrmRootCauseBranch, "unclassified">;
  readonly explanation: string;
  readonly nextCheck: string;
}
