import type { ExperimentDecisionGate } from "./experiment-decision-gate";
import type { PreRegistration } from "./run-preregistration";
import { guardrailBecause } from "./ship-recommendation-because";
import { combineEffects, goalEffects, resolvePrimaryEffect } from "./ship-recommendation-primary";
import type { RecommendationUnavailableReason, ShipRecommendation } from "./ship-recommendation";
import type { GuardrailResult, StatsOutput } from "./stats-result-contract";

/**
 * Precedence (plan 2.4; table in docs/spec/stats/result-contracts.md):
 *
 * | Order | Condition | Verdict |
 * | ----- | --------- | ------- |
 * | 1 | No pre-registration | unavailable (`no_pre_registration`) |
 * | 2 | Trust/health gate fail (SRM, activation, engine, Control, decision family) | invalid |
 * | 3 | Gate not ready (underpowered, planned duration) | keep_running |
 * | 4 | Primary harmful OR any Guardrail breached | do_not_ship |
 * | 5 | Primary undecided | keep_running |
 * | 6 | Primary beneficial per required margin, no Guardrail breach | ship |
 */

const INVALID_CHECK_IDS = new Set([
  "control_identity",
  "exposure_srm",
  "activated_srm",
  "activation_balance",
  "engine_status",
  "decision_valid_result",
]);

const NOT_READY_CHECK_IDS = new Set(["underpowered", "planned_duration"]);

export type ShipRecommendationResult =
  | { recommendation: ShipRecommendation; recommendationUnavailable?: undefined }
  | {
      recommendation?: undefined;
      recommendationUnavailable: RecommendationUnavailableReason;
    };

export function computeShipRecommendation(input: {
  preRegistration: PreRegistration | undefined;
  gate: ExperimentDecisionGate;
  stats: StatsOutput;
}): ShipRecommendationResult {
  if (input.preRegistration === undefined) {
    return { recommendationUnavailable: "no_pre_registration" };
  }

  const invalid = firstFailedCheck(input.gate, INVALID_CHECK_IDS);
  if (invalid) {
    return {
      recommendation: { verdict: "invalid", because: invalid.detail },
    };
  }

  const notReady = firstFailedCheck(input.gate, NOT_READY_CHECK_IDS);
  if (notReady) {
    return {
      recommendation: { verdict: "keep_running", because: notReady.detail },
    };
  }

  const primary = resolvePrimaryEffect(input.preRegistration, input.stats.arm_results);
  if (primary.status === "unavailable") {
    return { recommendationUnavailable: primary.reason };
  }

  const breached = firstBreachedGuardrail(input.stats.guardrail_results);
  const goals = goalEffects(input.preRegistration, input.stats.arm_results, primary);
  if (goals.status === "unavailable") {
    return { recommendationUnavailable: goals.reason };
  }

  const combined = combineEffects(
    input.preRegistration.ship_rule.conflict_resolution,
    primary.effect,
    goals.effects,
  );

  if (combined === "harmful" || breached !== undefined) {
    return {
      recommendation: {
        verdict: "do_not_ship",
        because:
          breached !== undefined
            ? guardrailBecause({
                ciLower: breached.ci_lower,
                threshold: breached.threshold,
                breachReason: breached.breach_reason,
              })
            : primary.because,
      },
    };
  }

  if (combined === "undecided") {
    return {
      recommendation: {
        verdict: "keep_running",
        because: primary.because,
      },
    };
  }

  return {
    recommendation: {
      verdict: "ship",
      because: `${primary.because.replace(/\.$/, "")} with no Guardrail breach.`,
    },
  };
}

function firstFailedCheck(
  gate: ExperimentDecisionGate,
  ids: ReadonlySet<string>,
): { detail: string } | null {
  const failed = gate.checks.find((check) => check.status === "fail" && ids.has(check.id));
  return failed ? { detail: failed.detail } : null;
}

function firstBreachedGuardrail(rows: readonly GuardrailResult[]): GuardrailResult | undefined {
  return rows.find((row) => row.is_breached === true);
}
