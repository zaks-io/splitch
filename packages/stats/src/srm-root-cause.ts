/**
 * Fabijan et al. 2019 SRM root-cause classifier over outputs the platform
 * already produces. It never recomputes chi-square or changes the gate; it
 * only names the likely diagnostic branch and the next check to run.
 *
 * `engagement_direction` and `latency_linked` need telemetry that does not
 * exist yet (see `SRM_ROOT_CAUSE_TELEMETRY_GAPS`). Those branches are omitted
 * rather than guessed.
 */

export const SRM_ROOT_CAUSE_BRANCHES = [
  "triggered_only",
  "segment_localized",
  "day_one",
  "unclassified",
] as const;

export type SrmRootCauseBranch = (typeof SRM_ROOT_CAUSE_BRANCHES)[number];

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

export interface SrmRootCauseClassification {
  readonly branch: SrmRootCauseBranch;
  readonly explanation: string;
  /** Concrete tool or route name the operator/agent should call next. */
  readonly nextCheck: string;
  /** Set on `unclassified`: every signal the classifier weighed. */
  readonly evidenceConsidered?: string[];
}

interface MatchedBranch {
  readonly branch: Exclude<SrmRootCauseBranch, "unclassified">;
  readonly explanation: string;
  readonly nextCheck: string;
}

/**
 * Returns `null` when neither Exposure nor activated-population SRM has fired.
 * Never invents a branch: ambiguous or conflicting signals become
 * `unclassified` with the evidence list.
 */
export function classifySrmRootCause(input: SrmRootCauseInput): SrmRootCauseClassification | null {
  validateInput(input);

  const exposureFired = input.exposureMismatch;
  const activatedFired = input.activatedMismatch === true;
  if (!exposureFired && !activatedFired) {
    return null;
  }

  const matches = collectMatches(input, exposureFired, activatedFired);
  if (matches.length === 1) {
    const only = matches[0];
    if (only === undefined) {
      throw new Error("SRM root-cause match list reported length 1 without an entry.");
    }
    return {
      branch: only.branch,
      explanation: only.explanation,
      nextCheck: only.nextCheck,
    };
  }

  return {
    branch: "unclassified",
    explanation:
      "Sample Ratio Mismatch fired, but the available signals do not isolate a single Fabijan branch.",
    nextCheck: "decision-diagnostics",
    evidenceConsidered: evidenceConsidered(input, exposureFired, activatedFired, matches),
  };
}

function collectMatches(
  input: SrmRootCauseInput,
  exposureFired: boolean,
  activatedFired: boolean,
): MatchedBranch[] {
  const matches: MatchedBranch[] = [];

  if (activatedFired && !exposureFired) {
    matches.push({
      branch: "triggered_only",
      explanation:
        "Activated-population SRM fires while Exposure SRM does not, so the Activation gate is the likely bias source.",
      nextCheck: "experiment_results_get",
    });
  }

  const segment = segmentLocalized(input.segmentCuts);
  if (segment !== null) {
    matches.push(segment);
  }

  const dayOne = dayOneBranch(input.dayBuckets);
  if (dayOne !== null) {
    matches.push(dayOne);
  }

  return matches;
}

function segmentLocalized(
  cuts: readonly SrmRootCauseSegmentCut[] | undefined,
): MatchedBranch | null {
  if (cuts === undefined) {
    return null;
  }
  const mismatched = cuts.filter((cut) => cut.srmIsMismatch);
  // Localized means some slices carry the imbalance and others do not.
  if (mismatched.length === 0 || mismatched.length === cuts.length) {
    return null;
  }
  const sample = mismatched[0];
  if (sample === undefined) {
    throw new Error("SRM root-cause mismatched segment list was empty after a non-empty filter.");
  }
  const label =
    mismatched.length === 1
      ? `${sample.dimensionId}=${sample.dimensionValue}`
      : `${mismatched.length} Dimension slices`;
  return {
    branch: "segment_localized",
    explanation: `SRM is concentrated in ${label} while other requested slices remain balanced.`,
    nextCheck: "decision-diagnostics",
  };
}

function dayOneBranch(days: readonly SrmRootCauseDayBucket[] | undefined): MatchedBranch | null {
  if (days === undefined || days.length === 0) {
    return null;
  }
  const first = days[0];
  if (first === undefined) {
    throw new Error("SRM root-cause dayBuckets reported length > 0 without a first day.");
  }
  if (!first.srmIsMismatch) {
    return null;
  }
  // Imbalance on day one only: later first-Exposure days do not themselves mismatch.
  if (days.slice(1).some((day) => day.srmIsMismatch)) {
    return null;
  }
  return {
    branch: "day_one",
    explanation:
      "SRM is concentrated in the first Exposure day; later first-Exposure days are balanced.",
    nextCheck: "decision-diagnostics",
  };
}

function evidenceConsidered(
  input: SrmRootCauseInput,
  exposureFired: boolean,
  activatedFired: boolean,
  matches: readonly MatchedBranch[],
): string[] {
  const evidence = [
    `exposure_srm:${exposureFired ? "mismatch" : "clean"}`,
    `activated_srm:${
      input.activatedMismatch === null ? "not_applicable" : activatedFired ? "mismatch" : "clean"
    }`,
  ];
  if (input.segmentCuts === undefined) {
    evidence.push("segment_cuts:absent");
  } else {
    evidence.push(
      `segment_cuts:mismatched_${input.segmentCuts.filter((c) => c.srmIsMismatch).length}_of_${input.segmentCuts.length}`,
    );
  }
  if (input.dayBuckets === undefined) {
    evidence.push("day_buckets:absent");
  } else {
    evidence.push(
      `day_buckets:mismatched_${input.dayBuckets.filter((d) => d.srmIsMismatch).length}_of_${input.dayBuckets.length}`,
    );
  }
  if (matches.length > 1) {
    evidence.push(`conflicting_branches:${matches.map((m) => m.branch).join(",")}`);
  }
  return evidence;
}

function validateInput(input: SrmRootCauseInput): void {
  assertBoolean("exposureMismatch", input.exposureMismatch);
  if (input.activatedMismatch !== null) {
    assertBoolean("activatedMismatch", input.activatedMismatch);
  }
  validateSegmentCuts(input.segmentCuts);
  validateDayBuckets(input.dayBuckets);
}

function assertBoolean(name: string, value: unknown): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean; received ${JSON.stringify(value)}.`);
  }
}

function validateSegmentCuts(cuts: readonly SrmRootCauseSegmentCut[] | undefined): void {
  if (cuts === undefined) return;
  for (const [index, cut] of cuts.entries()) {
    if (cut.dimensionId.trim() === "" || cut.dimensionValue.trim() === "") {
      throw new Error(`segmentCuts[${index}] requires non-empty dimensionId and dimensionValue.`);
    }
    assertBoolean(`segmentCuts[${index}].srmIsMismatch`, cut.srmIsMismatch);
  }
}

function validateDayBuckets(days: readonly SrmRootCauseDayBucket[] | undefined): void {
  if (days === undefined) return;
  for (const [index, day] of days.entries()) {
    if (day.day.trim() === "") {
      throw new Error(`dayBuckets[${index}].day must be a non-empty string.`);
    }
    assertBoolean(`dayBuckets[${index}].srmIsMismatch`, day.srmIsMismatch);
  }
}
