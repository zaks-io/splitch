import type { PreRegistration } from "./run-preregistration";
import {
  classifyTreatmentArms,
  relativeControlMeanGate,
  treatmentArmsFor,
  type ClassifiedEffect,
} from "./ship-recommendation-arms";
import { marginOnIntervalScale, type MetricEffectVerdict } from "./ship-recommendation-effect";
import { classifyLockedGoalMetrics } from "./ship-recommendation-locked-goals";
import type { RecommendationUnavailableReason } from "./ship-recommendation";
import type { ArmResult } from "./stats-result-arm";

export type { ClassifiedEffect } from "./ship-recommendation-arms";

export type PrimaryResolved =
  | { status: "ok"; classified: ClassifiedEffect }
  | { status: "unavailable"; reason: RecommendationUnavailableReason };

export function resolvePrimaryEffect(
  preRegistration: PreRegistration,
  arms: readonly ArmResult[],
  controlVariant: string,
): PrimaryResolved {
  const primaryMetric = requirePrimaryMetric(preRegistration);
  const treatmentArms = treatmentArmsFor(preRegistration.primary_metric_id, arms, controlVariant);
  if (treatmentArms.length === 0) {
    return { status: "unavailable", reason: "primary_result_unavailable" };
  }

  const scale = preRegistration.ship_rule.margin_scale;
  const relativeControl = relativeControlMeanGate(
    scale,
    preRegistration.primary_metric_id,
    arms,
    controlVariant,
  );
  if (relativeControl.status === "unavailable") return relativeControl;

  const marginOnScale = marginOnIntervalScale(preRegistration.ship_rule.required_margin, scale);

  const classified = classifyTreatmentArms({
    arms: treatmentArms,
    desirability: primaryMetric.desirability,
    scale,
    marginOnScale,
    subject: "Primary Metric",
  });
  if (classified.status === "unavailable") return classified;

  const effect = worstEffect(classified.rows.map((row) => row.effect));
  const deciding = classified.rows.find((row) => row.effect === effect) ?? classified.rows[0];
  if (deciding === undefined) {
    throw new Error("primary treatment arms empty after classify");
  }

  return {
    status: "ok",
    classified: deciding,
  };
}

export function goalEffects(
  preRegistration: PreRegistration,
  arms: readonly ArmResult[],
  controlVariant: string,
  primary: ClassifiedEffect,
  guardrailMetricIds: ReadonlySet<string>,
):
  | { status: "ok"; goals: ClassifiedEffect[] }
  | { status: "unavailable"; reason: RecommendationUnavailableReason } {
  if (preRegistration.ship_rule.conflict_resolution === "primary_wins") {
    return { status: "ok", goals: [primary] };
  }
  return classifyLockedGoalMetrics(preRegistration, arms, controlVariant, guardrailMetricIds);
}

export function combineEffects(
  resolution: PreRegistration["ship_rule"]["conflict_resolution"],
  primary: ClassifiedEffect,
  goals: readonly ClassifiedEffect[],
): ClassifiedEffect {
  if (resolution === "primary_wins") return primary;
  const harmful = goals.find((goal) => goal.effect === "harmful");
  if (harmful !== undefined) return harmful;
  if (resolution === "unanimous_goals") return combineUnanimous(primary, goals);
  return combineAnyGoal(primary, goals);
}

function combineUnanimous(
  primary: ClassifiedEffect,
  goals: readonly ClassifiedEffect[],
): ClassifiedEffect {
  if (goals.every((goal) => goal.effect === "beneficial")) {
    return firstWithEffect(goals, "beneficial") ?? primary;
  }
  return firstWithEffect(goals, "undecided") ?? primary;
}

function combineAnyGoal(
  primary: ClassifiedEffect,
  goals: readonly ClassifiedEffect[],
): ClassifiedEffect {
  return firstWithEffect(goals, "beneficial") ?? firstWithEffect(goals, "undecided") ?? primary;
}

function firstWithEffect(
  goals: readonly ClassifiedEffect[],
  effect: MetricEffectVerdict,
): ClassifiedEffect | undefined {
  return goals.find((goal) => goal.effect === effect);
}

function requirePrimaryMetric(preRegistration: PreRegistration) {
  const primaryMetric = preRegistration.metrics.find(
    (metric) => metric.metric_id === preRegistration.primary_metric_id,
  );
  if (primaryMetric === undefined) {
    throw new Error("pre-registration primary_metric_id is missing from metrics");
  }
  return primaryMetric;
}

function worstEffect(effects: readonly MetricEffectVerdict[]): MetricEffectVerdict {
  if (effects.some((effect) => effect === "harmful")) return "harmful";
  if (effects.every((effect) => effect === "beneficial")) return "beneficial";
  return "undecided";
}
