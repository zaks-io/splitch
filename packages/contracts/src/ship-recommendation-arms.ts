import type { PreRegistration } from "./run-preregistration";
import { effectBecause } from "./ship-recommendation-because";
import { classifyMetricEffect, type MetricEffectVerdict } from "./ship-recommendation-effect";
import type { RecommendationUnavailableReason } from "./ship-recommendation";
import type { ArmResult } from "./stats-result-arm";

export type ClassifiedEffect = {
  effect: MetricEffectVerdict;
  because: string;
  arm: ArmResult;
  interval: { lower: number; upper: number };
};

/** Treatments are every non-Control arm for the Metric (not "has relative lift"). */
export function treatmentArmsFor(
  metricId: string,
  arms: readonly ArmResult[],
  controlVariant: string,
): ArmResult[] {
  return arms.filter((arm) => arm.metric_id === metricId && arm.variant !== controlVariant);
}

/** Relative comparisons reverse desirability when Control mean is not positive. */
export function relativeControlMeanGate(
  scale: PreRegistration["ship_rule"]["margin_scale"],
  metricId: string,
  arms: readonly ArmResult[],
  controlVariant: string,
): { status: "ok" } | { status: "unavailable"; reason: RecommendationUnavailableReason } {
  if (scale !== "relative") return { status: "ok" };
  const control = arms.find((arm) => arm.metric_id === metricId && arm.variant === controlVariant);
  if (control === undefined) {
    return { status: "unavailable", reason: "primary_result_unavailable" };
  }
  if (!Number.isFinite(control.point_estimate) || control.point_estimate <= 0) {
    return { status: "unavailable", reason: "relative_control_mean_non_positive" };
  }
  return { status: "ok" };
}

export function unavailableForScale(
  reason: RecommendationUnavailableReason,
  scale: PreRegistration["ship_rule"]["margin_scale"],
): { status: "unavailable"; reason: RecommendationUnavailableReason } {
  if (scale === "absolute" && reason === "absolute_interval_unavailable") {
    return { status: "unavailable", reason };
  }
  return { status: "unavailable", reason: "primary_result_unavailable" };
}

export function classifyTreatmentArms(input: {
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
