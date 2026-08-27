import { controlIdentityCheck } from "./experiment-control-identity-check";
import { decisionValidMembers, lockedFamilyMembers, named } from "./experiment-decision-family";
import type {
  DecisionGateCheck,
  ExperimentSrmDiagnostics,
  SrmSignal,
} from "./experiment-decision-gate";
import { formatPValue } from "./p-value-format";
import type { StatsOutput, StatsResultStatus } from "./stats-result-contract";

export { controlIdentityCheck };

/**
 * The individual readiness checks behind the ship-decision gate.
 *
 * Each check answers one question and cites the evidence it used. A check may
 * only report `pass` on evidence it actually looked at; where there is nothing
 * to assess it reports `not_applicable` rather than borrowing a pass.
 */

/** Statsig-style caution band: noisy enough to watch, not to condemn. */
export const SRM_CAUTION_P = 0.01;
/** SRM chi-square hard threshold (docs/spec/stats/srm-and-health.md). */
const SRM_MISMATCH_P = 0.001;

/**
 * How far a Metric result is from supporting a decision.
 *
 * Written as a total map rather than a switch so that a status added to
 * `StatsResultStatus` breaks this build. A status the gate has not been taught
 * to read must never fall through to "shippable".
 */
type StatusClass = "decidable" | "collecting" | "starved" | "errored";

const STATUS_CLASS: Record<StatsResultStatus, StatusClass> = {
  ready: "decidable",
  stopped: "decidable",
  running: "collecting",
  insufficient_n: "starved",
  insufficient_denominator: "starved",
  error: "errored",
};

function classifyStatus(status: StatsResultStatus): StatusClass {
  // Unreachable through the validated contract, which closes the enum. Kept as
  // a refusal rather than a fall-through so an unrecognized status cannot ship.
  return STATUS_CLASS[status] ?? "errored";
}

/**
 * Whether the engine says SRM is firing.
 *
 * The engine's own boolean is the authority. The p-value threshold is only a
 * fallback for a payload that omitted the verdict; deriving the verdict from a
 * threshold the engine already applied would let this module quietly hold a
 * different bar than the stats engine does.
 */
export function srmIsFiring(signal: {
  pValue: number | null;
  isMismatch: boolean | null;
}): boolean {
  if (signal.isMismatch !== null) return signal.isMismatch;
  return signal.pValue !== null && signal.pValue < SRM_MISMATCH_P;
}

export function exposureSrmCheck(signal: SrmSignal, isMismatch: boolean | null): DecisionGateCheck {
  const p = formatP(signal.pValue);
  if (srmIsFiring({ pValue: signal.pValue, isMismatch })) {
    return {
      id: "exposure_srm",
      status: "fail",
      title: "Sample Ratio Mismatch is firing",
      detail: `Exposures are split differently than allocated (chi-square p = ${p}). Assignment is untrustworthy, so no Variant can be called a winner. Diagnose the cause and start a new Run.`,
    };
  }
  // The caution band warns without blocking. It often self-resolves, and
  // blocking on it here would hold a stricter bar than the stats spec sets.
  if (signal.tier === "possible_imbalance") {
    return {
      id: "exposure_srm",
      status: "pass",
      title: "Exposure split is within tolerance, with a caution",
      detail: `Chi-square p = ${p} sits in the ${SRM_MISMATCH_P}-${SRM_CAUTION_P} caution band. That is worth watching and often self-resolves, but it is not a Sample Ratio Mismatch and does not block a decision.`,
    };
  }
  return {
    id: "exposure_srm",
    status: "pass",
    title: "Exposure split matches allocation",
    detail: `Chi-square p = ${p}, above the ${SRM_CAUTION_P} caution band.`,
  };
}

export function activatedSrmCheck(
  signal: SrmSignal | null,
  isMismatch: boolean | null,
): DecisionGateCheck {
  if (!signal) {
    return {
      id: "activated_srm",
      status: "not_applicable",
      title: "Activated-population SRM",
      detail: "This Experiment has no activation gate, so there is no activated population.",
    };
  }
  const p = formatP(signal.pValue);
  if (srmIsFiring({ pValue: signal.pValue, isMismatch })) {
    return {
      id: "activated_srm",
      status: "fail",
      title: "Activated-population SRM is firing",
      detail: `The activated subpopulation is skewed (chi-square p = ${p}). This is the fingerprint of a Treatment-affected activation gate, and it biases the gated result even when the full exposure split looks clean.`,
    };
  }
  if (signal.tier === "possible_imbalance") {
    return {
      id: "activated_srm",
      status: "pass",
      title: "Activated population is balanced, with a caution",
      detail: `Chi-square p = ${p} on activated Entities sits in the caution band. Worth watching, not a mismatch.`,
    };
  }
  return {
    id: "activated_srm",
    status: "pass",
    title: "Activated population is balanced",
    detail: `Chi-square p = ${p} on activated Entities.`,
  };
}

export function activationBalanceCheck(
  balance: ExperimentSrmDiagnostics["activationBalance"],
  isMismatch: boolean | null,
): DecisionGateCheck {
  if (!balance) {
    return {
      id: "activation_balance",
      status: "not_applicable",
      title: "Per-Variant activation rate",
      detail: "This Experiment has no activation gate, so there is no activation rate to compare.",
    };
  }
  const p = formatP(balance.pValue);
  if (srmIsFiring({ pValue: balance.pValue, isMismatch })) {
    return {
      id: "activation_balance",
      status: "fail",
      title: "Per-Variant activation rate differs",
      detail: `Variants are activating at different rates (chi-square p = ${p}). The gap explains why the gated population is skewed and makes the gated result untrusted.`,
    };
  }
  if (balance.tier === "possible_imbalance") {
    return {
      id: "activation_balance",
      status: "pass",
      title: "Activation rates match across Variants, with a caution",
      detail: `Chi-square p = ${p} on activated vs not-activated by Variant sits in the caution band.`,
    };
  }
  return {
    id: "activation_balance",
    status: "pass",
    title: "Activation rates match across Variants",
    detail: `Chi-square p = ${p} on activated vs not-activated by Variant.`,
  };
}

/**
 * Refuses on engine states that are not a result at all.
 *
 * `error` means the estimator did not produce a usable interval. Rendering that
 * as merely "underpowered" would suggest waiting fixes it.
 */
export function engineStatusCheck(stats: StatsOutput): DecisionGateCheck {
  const decisionValid = decisionValidMembers(stats);
  const errored = decisionValid.filter(
    (member) => classifyStatus(member.result.status) === "errored",
  );
  if (decisionValid.length === 0) {
    return {
      id: "engine_status",
      status: "not_applicable",
      title: "Engine result status",
      detail: "This Run has no decision-valid Metric result to report a status for.",
    };
  }
  if (errored.length === 0) {
    return {
      id: "engine_status",
      status: "pass",
      title: "Every decision-valid Metric returned a usable result",
      detail: `The stats engine reported no estimation error across ${decisionValid.length} decision-valid ${decisionValid.length === 1 ? "result" : "results"}.`,
    };
  }
  return {
    id: "engine_status",
    status: "fail",
    title: "Stats engine reported an error",
    detail: `The estimator failed on ${named(errored)}. There is no interval to decide on, and waiting will not produce one. Investigate the Metric definition and the Run's inputs.`,
  };
}

export function underpoweredCheck(stats: StatsOutput): DecisionGateCheck {
  const decisionValid = decisionValidMembers(stats);
  // With nothing decision-valid to size, there is no evidence to pass on. Saying
  // "large enough" here would be a claim about zero Metrics.
  if (decisionValid.length === 0 && !stats.health.low_n_warning) {
    return {
      id: "underpowered",
      status: "not_applicable",
      title: "Sample size not assessed",
      detail: "This Run has no decision-valid Metric result to size.",
    };
  }
  const starved = decisionValid.filter(
    (member) => classifyStatus(member.result.status) === "starved",
  );
  if (starved.length > 0 || stats.health.low_n_warning) {
    const detail =
      starved.length > 0
        ? `Not enough data to decide on ${named(starved)}. Let the Run collect more Exposures.`
        : "At least one Variant is below the minimum Entity count for a decision. Let the Run collect more Exposures.";
    return { id: "underpowered", status: "fail", title: "Result is underpowered", detail };
  }
  // A fixed-horizon Run that has not reached its locked sample size reports
  // `running`, not a shortfall status. Treating that as decidable would hand a
  // ship decision to a Run that has not finished collecting.
  const collecting = decisionValid.filter(
    (member) => classifyStatus(member.result.status) === "collecting",
  );
  if (collecting.length > 0) {
    return {
      id: "underpowered",
      status: "fail",
      title: "Run has not reached its locked sample size",
      detail: `${named(collecting)} ${collecting.length === 1 ? "is" : "are"} still collecting. A fixed-horizon Run may only be decided at the sample size its Run froze.`,
    };
  }
  return {
    id: "underpowered",
    status: "pass",
    title: "No low-n warning",
    detail: `The stats engine raised no low-sample warning, and every decision-valid Metric returned a decidable result. This is an absence of a warning, not a power calculation.`,
  };
}

export function decisionValidCheck(stats: StatsOutput): DecisionGateCheck {
  const family = lockedFamilyMembers(stats);
  if (family.length > 0) {
    return {
      id: "decision_valid_result",
      status: "pass",
      title: "A locked decision family exists",
      detail: `${family.length} FDR-corrected goal Metric ${family.length === 1 ? "result belongs" : "results belong"} to the Run's locked decision spec.`,
    };
  }
  return {
    id: "decision_valid_result",
    status: "fail",
    title: "No decision-valid result",
    detail:
      "This Run has no FDR-corrected goal Metric in its locked decision family, so there is nothing a decision could be made on. Exploratory results cannot call an Experiment.",
  };
}

function formatP(value: number | null): string {
  return value === null ? "unavailable" : formatPValue(value);
}
