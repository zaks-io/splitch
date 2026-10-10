import type {
  ExperimentDecisionGate,
  GuardrailResult,
  PreRegistration,
  RecommendationUnavailableReason,
  ShipRecommendation,
  StatsOutput,
} from "@splitch/contracts";
import { guardrailBecause } from "./ship-recommendation-because";
import { combineEffects, goalEffects, resolvePrimaryEffect } from "./ship-recommendation-primary";

/**
 * Precedence (plan 2.4; table in docs/spec/stats/result-contracts.md):
 *
 * | Order | Condition | Verdict |
 * | ----- | --------- | ------- |
 * | 1 | No pre-registration | unavailable (`no_pre_registration`) |
 * | 2 | Trust/health gate fail (SRM, activation, engine, Control, decision family) | invalid |
 * | 3 | Gate not ready (underpowered, planned duration) | keep_running |
 * | 4 | Any Guardrail breached | do_not_ship (before interval availability) |
 * | 5 | Sequential Run + relative ship rule | unavailable (`relative_sequential_coverage_unproven`) |
 * | 6 | Relative rule with non-positive Control mean | unavailable (`relative_control_mean_non_positive`) |
 * | 7 | Combining goals with a locked goal missing desirability | unavailable (`locked_goal_desirability_missing`) |
 * | 8 | Primary / goal interval unavailable | unavailable |
 * | 9 | Combined goal harmful | do_not_ship |
 * | 10 | Combined goal undecided | keep_running |
 * | 11 | Combined goal beneficial, no Guardrail breach | ship |
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
  /** Frozen Control Variant key; Treatments are every other Variant. */
  controlVariant: string;
  /**
   * Run horizon. Sequential + relative ship rule is refused (Fieller coverage
   * unproven). Omit only in tests that exercise absolute rules.
   */
  horizon?: "sequential" | "fixed";
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

  // Known Guardrail breach wins over missing intervals (fail-loud on harm).
  const breached = firstBreachedGuardrail(input.stats.guardrail_results);
  if (breached !== undefined) {
    return {
      recommendation: {
        verdict: "do_not_ship",
        because: guardrailBecause({
          ciLower: breached.ci_lower,
          threshold: breached.threshold,
          breachReason: breached.breach_reason,
        }),
      },
    };
  }

  if (
    input.preRegistration.ship_rule.margin_scale === "relative" &&
    input.horizon === "sequential"
  ) {
    return { recommendationUnavailable: "relative_sequential_coverage_unproven" };
  }

  const primary = resolvePrimaryEffect(
    input.preRegistration,
    input.stats.arm_results,
    input.controlVariant,
  );
  if (primary.status === "unavailable") {
    return { recommendationUnavailable: primary.reason };
  }

  const guardrailMetricIds = new Set(input.stats.guardrail_results.map((row) => row.metric_id));
  const goals = goalEffects(
    input.preRegistration,
    input.stats.arm_results,
    input.controlVariant,
    primary.classified,
    guardrailMetricIds,
  );
  if (goals.status === "unavailable") {
    return { recommendationUnavailable: goals.reason };
  }

  const combined = combineEffects(
    input.preRegistration.ship_rule.conflict_resolution,
    primary.classified,
    goals.goals,
  );

  if (combined.effect === "harmful") {
    return {
      recommendation: {
        verdict: "do_not_ship",
        because: combined.because,
      },
    };
  }

  if (combined.effect === "undecided") {
    return {
      recommendation: {
        verdict: "keep_running",
        because: combined.because,
      },
    };
  }

  return {
    recommendation: {
      verdict: "ship",
      because: `${combined.because.replace(/\.$/, "")} with no Guardrail breach.`,
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
