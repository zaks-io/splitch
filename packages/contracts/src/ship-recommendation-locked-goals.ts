import type { PreRegistration } from "./run-preregistration";
import {
  classifyTreatmentArms,
  relativeControlMeanGate,
  treatmentArmsFor,
  unavailableForScale,
  type ClassifiedEffect,
} from "./ship-recommendation-arms";
import { marginOnIntervalScale } from "./ship-recommendation-effect";
import type { RecommendationUnavailableReason } from "./ship-recommendation";
import type { ArmResult } from "./stats-result-arm";

/**
 * Classify every locked goal Metric (BH family, non-Guardrail). Omitting one
 * from the freeze must not silently shrink unanimous_goals / any_goal.
 */
export function classifyLockedGoalMetrics(
  preRegistration: PreRegistration,
  arms: readonly ArmResult[],
  controlVariant: string,
  guardrailMetricIds: ReadonlySet<string>,
):
  | { status: "ok"; goals: ClassifiedEffect[] }
  | { status: "unavailable"; reason: RecommendationUnavailableReason } {
  const scale = preRegistration.ship_rule.margin_scale;
  const marginOnScale = marginOnIntervalScale(preRegistration.ship_rule.required_margin, scale);
  const metricsById = new Map(
    preRegistration.metrics.map((metric) => [metric.metric_id, metric] as const),
  );
  const lockedIds = lockedGoalMetricIds(arms, guardrailMetricIds);
  // Bonferroni k = comparisons that can ship (locked goals × Treatment arms).
  const shipMarginComparisonCount = countShipMarginComparisons(lockedIds, arms, controlVariant);
  const goals: ClassifiedEffect[] = [];

  for (const metricId of lockedIds) {
    const one = classifyOneLockedGoal({
      metricId,
      metric: metricsById.get(metricId),
      primaryMetricId: preRegistration.primary_metric_id,
      arms,
      controlVariant,
      scale,
      marginOnScale,
      shipMarginComparisonCount,
    });
    if (one.status === "unavailable") return one;
    goals.push(...one.rows);
  }
  if (goals.length === 0) {
    return { status: "unavailable", reason: "primary_result_unavailable" };
  }
  return { status: "ok", goals };
}

function countShipMarginComparisons(
  lockedIds: ReadonlySet<string>,
  arms: readonly ArmResult[],
  controlVariant: string,
): number {
  let count = 0;
  for (const metricId of lockedIds) {
    count += treatmentArmsFor(metricId, arms, controlVariant).length;
  }
  return count > 0 ? count : 1;
}

function classifyOneLockedGoal(input: {
  metricId: string;
  metric: PreRegistration["metrics"][number] | undefined;
  primaryMetricId: string;
  arms: readonly ArmResult[];
  controlVariant: string;
  scale: PreRegistration["ship_rule"]["margin_scale"];
  marginOnScale: number;
  shipMarginComparisonCount: number;
}):
  | { status: "ok"; rows: ClassifiedEffect[] }
  | { status: "unavailable"; reason: RecommendationUnavailableReason } {
  if (input.metric === undefined) {
    return { status: "unavailable", reason: "locked_goal_desirability_missing" };
  }
  const relativeControl = relativeControlMeanGate(
    input.scale,
    input.metricId,
    input.arms,
    input.controlVariant,
  );
  if (relativeControl.status === "unavailable") return relativeControl;
  const classified = classifyTreatmentArms({
    arms: treatmentArmsFor(input.metricId, input.arms, input.controlVariant),
    desirability: input.metric.desirability,
    scale: input.scale,
    marginOnScale: input.marginOnScale,
    subject: input.metricId === input.primaryMetricId ? "Primary Metric" : "Goal Metric",
    shipMarginComparisonCount: input.shipMarginComparisonCount,
  });
  if (classified.status === "unavailable") {
    return unavailableForScale(classified.reason, input.scale);
  }
  if (classified.rows.length === 0) {
    return { status: "unavailable", reason: "primary_result_unavailable" };
  }
  return { status: "ok", rows: classified.rows };
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
