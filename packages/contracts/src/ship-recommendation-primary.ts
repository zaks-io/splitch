import type { PreRegistration } from "./run-preregistration";
import { effectBecause } from "./ship-recommendation-because";
import {
  classifyMetricEffect,
  marginOnIntervalScale,
  type MetricEffectVerdict,
} from "./ship-recommendation-effect";
import type { RecommendationUnavailableReason } from "./ship-recommendation";
import type { ArmResult } from "./stats-result-arm";

export type ClassifiedEffect = {
  effect: MetricEffectVerdict;
  because: string;
  arm: ArmResult;
  interval: { lower: number; upper: number };
};

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

function classifyLockedGoalMetrics(
  preRegistration: PreRegistration,
  arms: readonly ArmResult[],
  controlVariant: string,
  guardrailMetricIds: ReadonlySet<string>,
):
  | { status: "ok"; goals: ClassifiedEffect[] }
  | { status: "unavailable"; reason: RecommendationUnavailableReason } {
  const scale = preRegistration.ship_rule.margin_scale;
  const marginOnScale = marginOnIntervalScale(preRegistration.ship_rule.required_margin, scale);
  const lockedGoalIds = lockedGoalMetricIds(arms, guardrailMetricIds);
  const goals: ClassifiedEffect[] = [];

  for (const metric of goalMetricsOnly(preRegistration, lockedGoalIds, guardrailMetricIds)) {
    const classified = classifyTreatmentArms({
      arms: treatmentArmsFor(metric.metric_id, arms, controlVariant),
      desirability: metric.desirability,
      scale,
      marginOnScale,
      subject:
        metric.metric_id === preRegistration.primary_metric_id ? "Primary Metric" : "Goal Metric",
    });
    if (classified.status === "unavailable") {
      return unavailableForScale(classified.reason, scale);
    }
    if (classified.rows.length === 0) {
      return { status: "unavailable", reason: "primary_result_unavailable" };
    }
    goals.push(...classified.rows);
  }
  if (goals.length === 0) {
    return { status: "unavailable", reason: "primary_result_unavailable" };
  }
  return { status: "ok", goals };
}

function goalMetricsOnly(
  preRegistration: PreRegistration,
  lockedGoalIds: ReadonlySet<string>,
  guardrailMetricIds: ReadonlySet<string>,
): PreRegistration["metrics"] {
  // Guardrails are evaluated only by breach rules; combine locked goals only.
  return preRegistration.metrics.filter(
    (metric) => !guardrailMetricIds.has(metric.metric_id) && lockedGoalIds.has(metric.metric_id),
  );
}

function lockedGoalMetricIds(
  arms: readonly ArmResult[],
  guardrailMetricIds: ReadonlySet<string>,
): Set<string> {
  const ids = new Set<string>();
  for (const arm of arms) {
    if (arm.in_bh_family && !guardrailMetricIds.has(arm.metric_id)) {
      ids.add(arm.metric_id);
    }
  }
  return ids;
}

function unavailableForScale(
  reason: RecommendationUnavailableReason,
  scale: PreRegistration["ship_rule"]["margin_scale"],
): { status: "unavailable"; reason: RecommendationUnavailableReason } {
  if (scale === "absolute" && reason === "absolute_interval_unavailable") {
    return { status: "unavailable", reason };
  }
  return { status: "unavailable", reason: "primary_result_unavailable" };
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

/** Treatments are every non-Control arm for the Metric (not "has relative lift"). */
function treatmentArmsFor(
  metricId: string,
  arms: readonly ArmResult[],
  controlVariant: string,
): ArmResult[] {
  return arms.filter((arm) => arm.metric_id === metricId && arm.variant !== controlVariant);
}

function classifyTreatmentArms(input: {
  arms: readonly ArmResult[];
  desirability: PreRegistration["metrics"][number]["desirability"];
  scale: PreRegistration["ship_rule"]["margin_scale"];
  marginOnScale: number;
  subject: "Primary Metric" | "Goal Metric";
}):
  | { status: "ok"; rows: ClassifiedEffect[] }
  | { status: "unavailable"; reason: RecommendationUnavailableReason } {
  const rows: ClassifiedEffect[] = [];

  for (const arm of input.arms) {
    const interval = intervalForScale(arm, input.scale);
    if (interval === null) {
      return {
        status: "unavailable",
        reason:
          input.scale === "absolute"
            ? "absolute_interval_unavailable"
            : "primary_result_unavailable",
      };
    }
    // A win requires eligible, FDR-corrected decision evidence — not raw margin.
    const effect = decisionEligible(arm)
      ? classifyMetricEffect({
          desirability: input.desirability,
          requiredMargin: input.marginOnScale,
          scale: input.scale,
          ciLower: interval.lower,
          ciUpper: interval.upper,
        })
      : ("undecided" as const);
    rows.push({
      arm,
      effect,
      interval,
      because: effectBecause({
        effect,
        desirability: input.desirability,
        scale: input.scale,
        ciLower: interval.lower,
        ciUpper: interval.upper,
        marginOnScale: input.marginOnScale,
        relativeLiftPct: arm.relative_lift_pct,
        subject: input.subject,
      }),
    });
  }
  return { status: "ok", rows };
}

function decisionEligible(arm: ArmResult): boolean {
  return (
    (arm.status === "ready" || arm.status === "stopped") &&
    arm.is_significant === true &&
    arm.in_bh_family === true &&
    arm.decision_valid === true
  );
}

function worstEffect(effects: readonly MetricEffectVerdict[]): MetricEffectVerdict {
  if (effects.some((effect) => effect === "harmful")) return "harmful";
  if (effects.every((effect) => effect === "beneficial")) return "beneficial";
  return "undecided";
}

function intervalForScale(
  arm: ArmResult,
  scale: PreRegistration["ship_rule"]["margin_scale"],
): { lower: number; upper: number } | null {
  if (scale === "relative") {
    return finitePair(arm.ci_lower, arm.ci_upper);
  }
  if (arm.absolute_ci_lower === undefined || arm.absolute_ci_upper === undefined) {
    return null;
  }
  return finitePair(arm.absolute_ci_lower, arm.absolute_ci_upper);
}

function finitePair(
  lower: number | null,
  upper: number | null,
): { lower: number; upper: number } | null {
  if (lower === null || upper === null || !Number.isFinite(lower) || !Number.isFinite(upper)) {
    return null;
  }
  return { lower, upper };
}
