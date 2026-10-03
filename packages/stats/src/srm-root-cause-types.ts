/**
 * Shared types and constants for the Fabijan et al. 2019 SRM root-cause
 * classifier. Classification lives in `srm-root-cause.ts`.
 */

export const SRM_ROOT_CAUSE_BRANCHES = ["triggered_only", "unclassified"] as const;

export type SrmRootCauseBranch = (typeof SRM_ROOT_CAUSE_BRANCHES)[number];

/**
 * Fabijan branches this classifier does not emit yet. `day_one` and
 * `segment_localized` need sounder inputs than boolean mismatch flags;
 * `engagement_direction` and `latency_linked` need telemetry that does not
 * exist.
 */
export const SRM_ROOT_CAUSE_FUTURE_BRANCHES = [
  {
    branch: "day_one",
    needed:
      "Per-day Variant counts with a proportion-change test (boolean day-mismatch flags confuse lower power with balance).",
  },
  {
    branch: "segment_localized",
    needed:
      "Per-Dimension mutually exclusive slices with multiplicity control (overlapping cuts across Dimensions are correlated).",
  },
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
