import type { PreRegistration } from "./run-preregistration";
import { effectBecause } from "./ship-recommendation-because";
import {
  classifyMetricEffect,
  marginOnIntervalScale,
  type MetricEffectVerdict,
} from "./ship-recommendation-effect";
import type { RecommendationUnavailableReason } from "./ship-recommendation";
import type { ArmResult } from "./stats-result-arm";

export type PrimaryResolved =
  | {
      status: "ok";
      effect: MetricEffectVerdict;
      because: string;
      arm: ArmResult;
    }
  | { status: "unavailable"; reason: RecommendationUnavailableReason };

export function resolvePrimaryEffect(
  preRegistration: PreRegistration,
  arms: readonly ArmResult[],
): PrimaryResolved {
  const primaryMetric = requirePrimaryMetric(preRegistration);
  const treatmentArms = treatmentArmsFor(preRegistration.primary_metric_id, arms);
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
  });
  if (classified.status === "unavailable") return classified;

  const effect = worstEffect(classified.rows.map((row) => row.effect));
  const deciding = classified.rows.find((row) => row.effect === effect) ?? classified.rows[0];
  if (deciding === undefined) {
    throw new Error("primary treatment arms empty after classify");
  }

  return {
    status: "ok",
    effect,
    arm: deciding.arm,
    because: effectBecause({
      effect,
      desirability: primaryMetric.desirability,
      scale,
      ciLower: deciding.interval.lower,
      ciUpper: deciding.interval.upper,
      marginOnScale,
      relativeLiftPct: deciding.arm.relative_lift_pct,
    }),
  };
}

export function goalEffects(
  preRegistration: PreRegistration,
  arms: readonly ArmResult[],
  primary: Extract<PrimaryResolved, { status: "ok" }>,
):
  | { status: "ok"; effects: MetricEffectVerdict[] }
  | { status: "unavailable"; reason: RecommendationUnavailableReason } {
  if (preRegistration.ship_rule.conflict_resolution === "primary_wins") {
    return { status: "ok", effects: [primary.effect] };
  }
  return classifyAllGoalMetrics(preRegistration, arms);
}

function classifyAllGoalMetrics(
  preRegistration: PreRegistration,
  arms: readonly ArmResult[],
):
  | { status: "ok"; effects: MetricEffectVerdict[] }
  | { status: "unavailable"; reason: RecommendationUnavailableReason } {
  const scale = preRegistration.ship_rule.margin_scale;
  const marginOnScale = marginOnIntervalScale(preRegistration.ship_rule.required_margin, scale);
  const effects: MetricEffectVerdict[] = [];

  for (const metric of preRegistration.metrics) {
    const classified = classifyTreatmentArms({
      arms: treatmentArmsFor(metric.metric_id, arms),
      desirability: metric.desirability,
      scale,
      marginOnScale,
    });
    if (classified.status === "unavailable") {
      return unavailableForScale(classified.reason, scale);
    }
    if (classified.rows.length === 0) {
      return { status: "unavailable", reason: "primary_result_unavailable" };
    }
    effects.push(...classified.rows.map((row) => row.effect));
  }
  return { status: "ok", effects };
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
  primary: MetricEffectVerdict,
  goals: readonly MetricEffectVerdict[],
): MetricEffectVerdict {
  if (resolution === "primary_wins") return primary;
  if (goals.some((effect) => effect === "harmful")) return "harmful";
  if (resolution === "unanimous_goals") {
    if (goals.every((effect) => effect === "beneficial")) return "beneficial";
    return "undecided";
  }
  if (goals.some((effect) => effect === "beneficial")) return "beneficial";
  return "undecided";
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

function treatmentArmsFor(metricId: string, arms: readonly ArmResult[]): ArmResult[] {
  return arms.filter((arm) => arm.metric_id === metricId && arm.relative_lift_pct !== null);
}

function classifyTreatmentArms(input: {
  arms: readonly ArmResult[];
  desirability: PreRegistration["metrics"][number]["desirability"];
  scale: PreRegistration["ship_rule"]["margin_scale"];
  marginOnScale: number;
}):
  | {
      status: "ok";
      rows: Array<{
        arm: ArmResult;
        effect: MetricEffectVerdict;
        interval: { lower: number; upper: number };
      }>;
    }
  | { status: "unavailable"; reason: RecommendationUnavailableReason } {
  const rows: Array<{
    arm: ArmResult;
    effect: MetricEffectVerdict;
    interval: { lower: number; upper: number };
  }> = [];

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
    const effect = armReady(arm)
      ? classifyMetricEffect({
          desirability: input.desirability,
          requiredMargin: input.marginOnScale,
          scale: input.scale,
          ciLower: interval.lower,
          ciUpper: interval.upper,
        })
      : ("undecided" as const);
    rows.push({ arm, effect, interval });
  }
  return { status: "ok", rows };
}

function armReady(arm: ArmResult): boolean {
  return arm.status === "ready" || arm.status === "stopped";
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
