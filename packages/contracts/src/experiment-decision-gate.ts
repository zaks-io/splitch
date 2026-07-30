import { z } from "zod";
import type { StatsOutput } from "./stats-result-contract";

/**
 * Worker-side evaluation of the Experiment ship-decision gate (ADR-0030).
 *
 * Rigor is enforced on the decision, never on the number: this module decides
 * whether "call the experiment" / "promote the winner" is permitted and cites
 * the failing check. Rendering surfaces (Panel, CLI, MCP) transport the result
 * of this function and never recompute it, so every skin refuses identically.
 *
 * There is deliberately no override input. An escape hatch would turn the
 * enforced contract back into an advisory one.
 */

/** SRM chi-square hard threshold (docs/spec/stats/srm-and-health.md). */
const SRM_MISMATCH_P = 0.001;
/** Statsig-style caution band: noisy enough to watch, not to condemn. */
const SRM_CAUTION_P = 0.01;

export const srmTiers = ["clean", "possible_imbalance", "confirmed"] as const;
export const SrmTierSchema = z.enum(srmTiers);

export const decisionGateCheckIds = [
  "exposure_srm",
  "activated_srm",
  "activation_balance",
  "underpowered",
  "decision_valid_result",
] as const;
export const DecisionGateCheckIdSchema = z.enum(decisionGateCheckIds);

export const SrmDeviationSchema = z
  .object({ variant: z.string(), observed: z.number(), expected: z.number() })
  .strict();

export const SrmSignalSchema = z
  .object({
    tier: SrmTierSchema,
    pValue: z.number().nullable(),
    /** Per-Variant observed minus expected exposures: the cause-hunting diagnostic. */
    deviations: z.array(SrmDeviationSchema),
  })
  .strict();

export const ExperimentSrmDiagnosticsSchema = z
  .object({
    exposure: SrmSignalSchema,
    /** Null when the Experiment has no activation gate (ADR-0012). */
    activated: SrmSignalSchema.nullable(),
    activationBalance: z
      .object({ tier: SrmTierSchema, pValue: z.number().nullable() })
      .strict()
      .nullable(),
  })
  .strict();

export const DecisionGateCheckSchema = z
  .object({
    id: DecisionGateCheckIdSchema,
    /** `not_applicable` keeps a check visible without implying it passed on evidence. */
    status: z.enum(["pass", "fail", "not_applicable"]),
    title: z.string(),
    detail: z.string(),
  })
  .strict();

export const ExperimentDecisionGateSchema = z
  .object({
    shipAllowed: z.boolean(),
    blockedBy: z.array(DecisionGateCheckIdSchema),
    checks: z.array(DecisionGateCheckSchema),
    /** Names the enforcement point so a rendering surface can attribute the refusal. */
    enforcedBy: z.literal("control-plane-api"),
  })
  .strict();

export type SrmTier = z.infer<typeof SrmTierSchema>;
export type SrmDeviation = z.infer<typeof SrmDeviationSchema>;
export type SrmSignal = z.infer<typeof SrmSignalSchema>;
export type ExperimentSrmDiagnostics = z.infer<typeof ExperimentSrmDiagnosticsSchema>;
export type DecisionGateCheckId = z.infer<typeof DecisionGateCheckIdSchema>;
export type DecisionGateCheck = z.infer<typeof DecisionGateCheckSchema>;
export type ExperimentDecisionGate = z.infer<typeof ExperimentDecisionGateSchema>;

export function srmTierFor(pValue: number | null, isMismatch: boolean | null): SrmTier {
  if (isMismatch === true || (pValue !== null && pValue < SRM_MISMATCH_P)) return "confirmed";
  if (pValue !== null && pValue < SRM_CAUTION_P) return "possible_imbalance";
  return "clean";
}

export function experimentSrmDiagnostics(stats: StatsOutput): ExperimentSrmDiagnostics {
  const hasActivationGate =
    stats.srm.activated_srm_p_value !== null || stats.srm.activated_srm_mismatch !== null;
  const hasActivationBalance =
    stats.health.activation_balance_p_value !== null ||
    stats.health.activation_balance_mismatch !== null;
  return {
    exposure: {
      tier: srmTierFor(stats.srm.srm_p_value, stats.srm.srm_is_mismatch),
      pValue: stats.srm.srm_p_value,
      deviations: srmDeviations(stats.srm.observed_counts, stats.srm.expected_counts),
    },
    activated: hasActivationGate
      ? {
          tier: srmTierFor(stats.srm.activated_srm_p_value, stats.srm.activated_srm_mismatch),
          pValue: stats.srm.activated_srm_p_value,
          deviations: [],
        }
      : null,
    activationBalance: hasActivationBalance
      ? {
          tier: srmTierFor(
            stats.health.activation_balance_p_value,
            stats.health.activation_balance_mismatch,
          ),
          pValue: stats.health.activation_balance_p_value,
        }
      : null,
  };
}

export function evaluateExperimentDecisionGate(stats: StatsOutput): ExperimentDecisionGate {
  const srm = experimentSrmDiagnostics(stats);
  const checks: DecisionGateCheck[] = [
    exposureSrmCheck(srm.exposure),
    activatedSrmCheck(srm.activated),
    activationBalanceCheck(srm.activationBalance),
    underpoweredCheck(stats),
    decisionValidCheck(stats),
  ];
  const blockedBy = checks.filter((check) => check.status === "fail").map((check) => check.id);
  return {
    shipAllowed: blockedBy.length === 0,
    blockedBy,
    checks,
    enforcedBy: "control-plane-api",
  };
}

function exposureSrmCheck(signal: SrmSignal): DecisionGateCheck {
  const p = formatP(signal.pValue);
  if (signal.tier === "confirmed") {
    return {
      id: "exposure_srm",
      status: "fail",
      title: "Sample Ratio Mismatch is firing",
      detail: `Exposures are split differently than allocated (chi-square p = ${p}). Assignment is untrustworthy, so no Variant can be called a winner. Diagnose the cause and start a new Run.`,
    };
  }
  if (signal.tier === "possible_imbalance") {
    return {
      id: "exposure_srm",
      status: "fail",
      title: "Possible exposure imbalance",
      detail: `Exposure split is in the SRM caution band (chi-square p = ${p}). This band often self-resolves, but a decision may not be made until it clears.`,
    };
  }
  return {
    id: "exposure_srm",
    status: "pass",
    title: "Exposure split matches allocation",
    detail: `Chi-square p = ${p}, above the ${SRM_CAUTION_P} caution band.`,
  };
}

function activatedSrmCheck(signal: SrmSignal | null): DecisionGateCheck {
  if (!signal) {
    return {
      id: "activated_srm",
      status: "not_applicable",
      title: "Activated-population SRM",
      detail: "This Experiment has no activation gate, so there is no activated population.",
    };
  }
  const p = formatP(signal.pValue);
  if (signal.tier === "clean") {
    return {
      id: "activated_srm",
      status: "pass",
      title: "Activated population is balanced",
      detail: `Chi-square p = ${p} on activated Entities.`,
    };
  }
  return {
    id: "activated_srm",
    status: "fail",
    title:
      signal.tier === "confirmed"
        ? "Activated-population SRM is firing"
        : "Possible activated-population imbalance",
    detail: `The activated subpopulation is skewed (chi-square p = ${p}). This is the fingerprint of a Treatment-affected activation gate, and it biases the gated result even when the full exposure split looks clean.`,
  };
}

function activationBalanceCheck(
  balance: ExperimentSrmDiagnostics["activationBalance"],
): DecisionGateCheck {
  if (!balance) {
    return {
      id: "activation_balance",
      status: "not_applicable",
      title: "Per-arm activation rate",
      detail: "This Experiment has no activation gate, so there is no activation rate to compare.",
    };
  }
  const p = formatP(balance.pValue);
  if (balance.tier === "clean") {
    return {
      id: "activation_balance",
      status: "pass",
      title: "Activation rates match across arms",
      detail: `Chi-square p = ${p} on activated vs not-activated by arm.`,
    };
  }
  return {
    id: "activation_balance",
    status: "fail",
    title:
      balance.tier === "confirmed"
        ? "Per-arm activation rate differs"
        : "Possible per-arm activation-rate gap",
    detail: `Arms are activating at different rates (chi-square p = ${p}). The gap explains why the gated population is skewed and makes the gated result untrusted.`,
  };
}

function underpoweredCheck(stats: StatsOutput): DecisionGateCheck {
  const decisionValid = stats.arm_results.filter((result) => result.decision_valid);
  const starved = decisionValid.filter(
    (result) => result.status === "insufficient_n" || result.status === "insufficient_denominator",
  );
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
  if (starved.length === 0 && !stats.health.low_n_warning) {
    return {
      id: "underpowered",
      status: "pass",
      title: "Sample is large enough to decide",
      detail: "Every decision-valid Metric has enough Entities to support a call.",
    };
  }
  const named = starved.map((result) => `${result.metric_id} / ${result.variant}`);
  return {
    id: "underpowered",
    status: "fail",
    title: "Result is underpowered",
    detail:
      named.length > 0
        ? `Not enough data to decide on ${named.join(", ")}. Let the Run collect more Exposures.`
        : "At least one arm is below the minimum Entity count for a decision. Let the Run collect more Exposures.",
  };
}

function decisionValidCheck(stats: StatsOutput): DecisionGateCheck {
  const family = stats.arm_results.filter((result) => result.in_bh_family && result.decision_valid);
  if (family.length > 0) {
    return {
      id: "decision_valid_result",
      status: "pass",
      title: "A locked decision family exists",
      detail: `${family.length} FDR-corrected goal Metric ${family.length === 1 ? "result" : "results"} belong to the Run's locked decision spec.`,
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

function srmDeviations(
  observed: Record<string, number>,
  expected: Record<string, number>,
): SrmDeviation[] {
  return [...new Set([...Object.keys(observed), ...Object.keys(expected)])]
    .sort()
    .map((variant) => ({
      variant,
      observed: observed[variant] ?? 0,
      expected: expected[variant] ?? 0,
    }));
}

function formatP(value: number | null): string {
  if (value === null) return "unavailable";
  return value < 0.0001 ? "<0.0001" : value.toPrecision(3);
}
