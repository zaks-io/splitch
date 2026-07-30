import { z } from "zod";
import type { FrozenControlIdentity } from "./experiment-control-identity";
import {
  activatedSrmCheck,
  activationBalanceCheck,
  controlIdentityCheck,
  decisionValidCheck,
  engineStatusCheck,
  exposureSrmCheck,
  SRM_CAUTION_P,
  srmIsFiring,
  underpoweredCheck,
} from "./experiment-decision-gate-checks";
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

export const srmTiers = ["clean", "possible_imbalance", "confirmed"] as const;
export const SrmTierSchema = z.enum(srmTiers);

export const decisionGateCheckIds = [
  "control_identity",
  "exposure_srm",
  "activated_srm",
  "activation_balance",
  "engine_status",
  "underpowered",
  "decision_valid_result",
] as const;
export const DecisionGateCheckIdSchema = z.enum(decisionGateCheckIds);

export const SrmDeviationSchema = z
  .object({
    variant: z.string(),
    observed: z.number(),
    expected: z.number(),
    /**
     * Observed minus expected, computed here so every surface reports the same
     * number. A skin that subtracted the two itself would be doing arithmetic
     * on a diagnostic, which is exactly what the Worker is authoritative for.
     */
    delta: z.number(),
  })
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

/**
 * The tier the rendering surface shows must be the same verdict the gate
 * enforces, or the page condemns a Run the gate is happy to ship. Both read
 * `srmIsFiring`, so the engine's boolean wins in both places and a payload
 * carrying `srm_is_mismatch: false` with a sub-threshold p-value lands in the
 * caution band rather than being labelled a confirmed mismatch.
 */
export function srmTierFor(pValue: number | null, isMismatch: boolean | null): SrmTier {
  if (srmIsFiring({ pValue, isMismatch })) return "confirmed";
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

export function evaluateExperimentDecisionGate(
  stats: StatsOutput,
  control: FrozenControlIdentity,
): ExperimentDecisionGate {
  const srm = experimentSrmDiagnostics(stats);
  const checks: DecisionGateCheck[] = [
    controlIdentityCheck(control),
    exposureSrmCheck(srm.exposure, stats.srm.srm_is_mismatch),
    activatedSrmCheck(srm.activated, stats.srm.activated_srm_mismatch),
    activationBalanceCheck(srm.activationBalance, stats.health.activation_balance_mismatch),
    engineStatusCheck(stats),
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

function srmDeviations(
  observed: Record<string, number>,
  expected: Record<string, number>,
): SrmDeviation[] {
  return [...new Set([...Object.keys(observed), ...Object.keys(expected)])]
    .sort()
    .map((variant) => {
      const observedCount = observed[variant] ?? 0;
      const expectedCount = expected[variant] ?? 0;
      return {
        variant,
        observed: observedCount,
        expected: expectedCount,
        delta: observedCount - expectedCount,
      };
    });
}
