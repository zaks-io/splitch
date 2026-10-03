/**
 * Fabijan et al. 2019 SRM root-cause classifier over outputs the platform
 * already produces. It never recomputes the decision-gate SRM statistic or
 * changes the gate; it only names the likely diagnostic branch and the next
 * check to run.
 *
 * `day_one`, `segment_localized`, `engagement_direction`, and `latency_linked`
 * are omitted (see `SRM_ROOT_CAUSE_FUTURE_BRANCHES`) rather than guessed from
 * unsound inputs or missing telemetry.
 */

import {
  SRM_ROOT_CAUSE_NEXT_CHECK,
  type SrmRootCauseClassification,
  type SrmRootCauseInput,
  type SrmRootCauseMatchedBranch,
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

  return matches;
}

function evidenceConsidered(
  input: SrmRootCauseInput,
  exposureFired: boolean,
  activatedFired: boolean,
  matches: readonly SrmRootCauseMatchedBranch[],
  extras: {
    zeroActivationInsufficient?: boolean;
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
}

function assertBoolean(name: string, value: unknown): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean; received ${JSON.stringify(value)}.`);
  }
}
