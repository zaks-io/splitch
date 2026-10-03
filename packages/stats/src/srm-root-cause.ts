/**
 * Fabijan et al. 2019 SRM root-cause classifier over outputs the platform
 * already produces. It never recomputes the decision-gate SRM statistic or
 * changes the gate; it only names the likely diagnostic branch and the next
 * check to run. Segment localization may run a separate homogeneity test over
 * already-sliced arm counts (not the gate test).
 *
 * `engagement_direction` and `latency_linked` need telemetry that does not
 * exist yet (see `SRM_ROOT_CAUSE_TELEMETRY_GAPS`). Those branches are omitted
 * rather than guessed.
 */

import {
  segmentLocalizedMatch,
  segmentThresholdCrossingsWithoutLocalization,
} from "./srm-root-cause-segment";
import {
  SRM_ROOT_CAUSE_NEXT_CHECK,
  type SrmRootCauseClassification,
  type SrmRootCauseDayBucket,
  type SrmRootCauseInput,
  type SrmRootCauseMatchedBranch,
  type SrmRootCauseSegmentCut,
} from "./srm-root-cause-types";

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

  const zeroActivationInsufficient =
    activatedFired && input.activationCount !== null && input.activationCount === 0;
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

  if (matches.length === 0 && zeroActivationInsufficient && !exposureFired) {
    return {
      branch: "unclassified",
      explanation:
        "Activated SRM is a fail-closed sentinel with zero Activations, which is insufficient evidence for an Activation-gate (triggered_only) root cause.",
      nextCheck: SRM_ROOT_CAUSE_NEXT_CHECK,
      evidenceConsidered: evidenceConsidered(input, exposureFired, activatedFired, matches, {
        zeroActivationInsufficient: true,
      }),
    };
  }

  const thresholdOnly = segmentThresholdCrossingsWithoutLocalization(input.segmentCuts);
  if (matches.length === 0 && thresholdOnly !== null) {
    return {
      branch: "unclassified",
      explanation: thresholdOnly.explanation,
      nextCheck: SRM_ROOT_CAUSE_NEXT_CHECK,
      evidenceConsidered: evidenceConsidered(input, exposureFired, activatedFired, matches, {
        zeroActivationInsufficient,
        segmentThresholdNote: thresholdOnly.evidenceTag,
      }),
    };
  }

  return {
    branch: "unclassified",
    explanation:
      "Sample Ratio Mismatch fired, but the available signals do not isolate a single Fabijan branch.",
    nextCheck: SRM_ROOT_CAUSE_NEXT_CHECK,
    evidenceConsidered: evidenceConsidered(input, exposureFired, activatedFired, matches, {
      zeroActivationInsufficient,
    }),
  };
}

function collectMatches(
  input: SrmRootCauseInput,
  exposureFired: boolean,
  activatedFired: boolean,
): SrmRootCauseMatchedBranch[] {
  const matches: SrmRootCauseMatchedBranch[] = [];

  // Zero Activations: activated_srm_mismatch is a fail-closed sentinel, not
  // evidence the Activation gate skewed the activated population. Require a
  // positive activation count before claiming triggered_only.
  if (
    activatedFired &&
    !exposureFired &&
    input.activationCount !== null &&
    input.activationCount > 0
  ) {
    matches.push({
      branch: "triggered_only",
      explanation:
        "Activated-population SRM fires while Exposure SRM does not, so the Activation gate is the likely bias source.",
      nextCheck: SRM_ROOT_CAUSE_NEXT_CHECK,
    });
  }

  const segment = segmentLocalizedMatch(input.segmentCuts);
  if (segment !== null) {
    matches.push(segment);
  }

  const dayOne = dayOneBranch(input.dayBuckets);
  if (dayOne !== null) {
    matches.push(dayOne);
  }

  return matches;
}

function dayOneBranch(
  days: readonly SrmRootCauseDayBucket[] | undefined,
): SrmRootCauseMatchedBranch | null {
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
  // Presence in dayBuckets means the day was scored (enough volume for SRM).
  // A singleton mismatching day cannot claim "later days are balanced".
  const later = days.slice(1);
  if (later.length === 0 || later.some((day) => day.srmIsMismatch)) {
    return null;
  }
  return {
    branch: "day_one",
    explanation:
      "SRM is concentrated in the first Exposure day; later first-Exposure days are balanced.",
    nextCheck: SRM_ROOT_CAUSE_NEXT_CHECK,
  };
}

function evidenceConsidered(
  input: SrmRootCauseInput,
  exposureFired: boolean,
  activatedFired: boolean,
  matches: readonly SrmRootCauseMatchedBranch[],
  extras: {
    zeroActivationInsufficient?: boolean;
    segmentThresholdNote?: string;
  } = {},
): string[] {
  const evidence = [
    `exposure_srm:${exposureFired ? "mismatch" : "clean"}`,
    activatedSrmEvidence(input.activatedMismatch, activatedFired),
    `activation_count:${input.activationCount === null ? "absent" : String(input.activationCount)}`,
  ];
  if (extras.zeroActivationInsufficient === true) {
    evidence.push("insufficient_evidence:zero_activations");
  }
  evidence.push(segmentCutsEvidence(input.segmentCuts));
  if (extras.segmentThresholdNote !== undefined) {
    evidence.push(extras.segmentThresholdNote);
  }
  evidence.push(dayBucketsEvidence(input.dayBuckets));
  if (matches.length > 1) {
    evidence.push(`conflicting_branches:${matches.map((m) => m.branch).join(",")}`);
  }
  return evidence;
}

function activatedSrmEvidence(activatedMismatch: boolean | null, activatedFired: boolean): string {
  if (activatedMismatch === null) {
    return "activated_srm:not_applicable";
  }
  return activatedFired ? "activated_srm:mismatch" : "activated_srm:clean";
}

function segmentCutsEvidence(cuts: readonly SrmRootCauseSegmentCut[] | undefined): string {
  if (cuts === undefined) {
    return "segment_cuts:absent";
  }
  const mismatched = cuts.filter((c) => c.srmIsMismatch).length;
  return `segment_cuts:mismatched_${mismatched}_of_${cuts.length}`;
}

function dayBucketsEvidence(days: readonly SrmRootCauseDayBucket[] | undefined): string {
  if (days === undefined) {
    return "day_buckets:absent";
  }
  const mismatched = days.filter((d) => d.srmIsMismatch).length;
  return `day_buckets:mismatched_${mismatched}_of_${days.length}`;
}

function validateInput(input: SrmRootCauseInput): void {
  assertBoolean("exposureMismatch", input.exposureMismatch);
  if (input.activatedMismatch !== null) {
    assertBoolean("activatedMismatch", input.activatedMismatch);
  }
  if (input.activationCount !== null) {
    if (
      typeof input.activationCount !== "number" ||
      !Number.isInteger(input.activationCount) ||
      input.activationCount < 0
    ) {
      throw new Error(
        `activationCount must be a non-negative integer or null; received ${JSON.stringify(input.activationCount)}.`,
      );
    }
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
    if (cut.observedCounts !== undefined) {
      validateObservedCounts(`segmentCuts[${index}].observedCounts`, cut.observedCounts);
    }
  }
}

function validateObservedCounts(name: string, counts: Readonly<Record<string, number>>): void {
  const entries = Object.entries(counts);
  if (entries.length === 0) {
    throw new Error(`${name} must include at least one Variant count.`);
  }
  for (const [variant, count] of entries) {
    if (variant.trim() === "") {
      throw new Error(`${name} Variant keys must be non-empty.`);
    }
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      throw new Error(
        `${name}.${variant} must be a non-negative integer; received ${JSON.stringify(count)}.`,
      );
    }
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
