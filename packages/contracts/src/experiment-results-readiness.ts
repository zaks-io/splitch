import { z } from "zod";
import type { DecisionGateCheck, DecisionGateCheckId } from "./experiment-decision-gate";

/**
 * Control Plane result readiness (plan item 0.15 / C10 part one).
 *
 * Statistical readiness means the analysis evidence supports a decision: the
 * evidence-side gate checks pass. Conclude-executable means Conclude can run
 * right now: statistical readiness plus lifecycle, planned duration, evidence
 * handles, and the caller's conclude permission. Ship recommendation (plan 2.4)
 * is a separate producer member computed from the locked ship rule.
 */

export const experimentResultsViews = ["concise", "detailed"] as const;
export const ExperimentResultsViewSchema = z.enum(experimentResultsViews);
export type ExperimentResultsView = z.infer<typeof ExperimentResultsViewSchema>;

export const ExperimentResultsReadinessSchema = z
  .object({
    /** True when every evidence-side gate check passes (not lifecycle/duration/permission). */
    statistical: z.boolean(),
    /** True when Conclude is executable for this caller on this evidence right now. */
    concludeExecutable: z.boolean(),
  })
  .strict();
export type ExperimentResultsReadiness = z.infer<typeof ExperimentResultsReadinessSchema>;

/** Gate check ids that judge analysis evidence, not Run wall-clock or caller role. */
export const statisticalGateCheckIds = [
  "control_identity",
  "exposure_srm",
  "activated_srm",
  "activation_balance",
  "engine_status",
  "underpowered",
  "decision_valid_result",
] as const satisfies readonly DecisionGateCheckId[];

const STATISTICAL_CHECK_IDS: ReadonlySet<string> = new Set(statisticalGateCheckIds);

export function statisticalReadiness(checks: readonly DecisionGateCheck[]): boolean {
  return !checks.some((check) => check.status === "fail" && STATISTICAL_CHECK_IDS.has(check.id));
}

export function reasonsFromChecks(checks: readonly DecisionGateCheck[]): string[] {
  return checks.filter((check) => check.status === "fail").map((check) => check.detail);
}
