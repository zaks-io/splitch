import type {
  ArmResult,
  PreRegistration,
  RecommendationUnavailableReason,
} from "@splitch/contracts";
import { effectBecause } from "./ship-recommendation-because";
import {
  classifyMetricEffect,
  clearsRequiredMargin,
  type MetricEffectVerdict,
} from "./ship-recommendation-effect";

export type ClassifiedEffect = {
  effect: MetricEffectVerdict;
  because: string;
  arm: ArmResult;
  interval: { lower: number; upper: number };
};

type Interval = { lower: number; upper: number };

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
  /**
   * Metric×Treatment comparisons that can trigger shipping under the combining
   * ship rule. When k > 1, margin clearance uses the published alpha/k
   * simultaneous interval.
   */
  shipMarginComparisonCount: number;
}):
  | { status: "ok"; rows: ClassifiedEffect[] }
  | { status: "unavailable"; reason: RecommendationUnavailableReason } {
  const rows: ClassifiedEffect[] = [];

  for (const arm of input.arms) {
    const classified = classifyOneTreatmentArm(arm, input);
    if (classified.status === "unavailable") return classified;
    rows.push(classified.row);
  }
  return { status: "ok", rows };
}

function classifyOneTreatmentArm(
  arm: ArmResult,
  input: {
    desirability: PreRegistration["metrics"][number]["desirability"];
    scale: PreRegistration["ship_rule"]["margin_scale"];
    marginOnScale: number;
    subject: "Primary Metric" | "Goal Metric";
    shipMarginComparisonCount: number;
  },
):
  | { status: "ok"; row: ClassifiedEffect }
  | { status: "unavailable"; reason: RecommendationUnavailableReason } {
  const interval = intervalForScale(arm, input.scale);
  if (interval === null) {
    return { status: "unavailable", reason: missingIntervalReason(input.scale) };
  }
  const marginInterval =
    input.shipMarginComparisonCount > 1 ? simultaneousIntervalForScale(arm, input.scale) : interval;
  if (marginInterval === null) {
    return { status: "unavailable", reason: missingIntervalReason(input.scale) };
  }

  const effectInput = {
    desirability: input.desirability,
    requiredMargin: input.marginOnScale,
    scale: input.scale,
    ciLower: interval.lower,
    ciUpper: interval.upper,
    marginCiLower: marginInterval.lower,
    marginCiUpper: marginInterval.upper,
  };
  const eligible = decisionEligible(arm);
  const clearedMargin = clearsRequiredMargin(effectInput);
  // A win requires eligible, FDR-corrected decision evidence — not raw margin.
  const effect = eligible ? classifyMetricEffect(effectInput) : ("undecided" as const);
  const cited = effect === "harmful" ? interval : marginInterval;
  return {
    status: "ok",
    row: {
      arm,
      effect,
      interval: cited,
      because: effectBecause({
        effect,
        desirability: input.desirability,
        scale: input.scale,
        ciLower: cited.lower,
        ciUpper: cited.upper,
        marginOnScale: input.marginOnScale,
        relativeLiftPct: arm.relative_lift_pct,
        subject: input.subject,
        eligibilityFailure:
          !eligible && clearedMargin ? "fdr_decision_evidence_missing" : undefined,
      }),
    },
  };
}

function missingIntervalReason(
  scale: PreRegistration["ship_rule"]["margin_scale"],
): RecommendationUnavailableReason {
  return scale === "absolute" ? "absolute_interval_unavailable" : "primary_result_unavailable";
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
): Interval | null {
  if (scale === "relative") {
    return finitePair(arm.ci_lower, arm.ci_upper);
  }
  if (arm.absolute_ci_lower === undefined || arm.absolute_ci_upper === undefined) {
    return null;
  }
  return finitePair(arm.absolute_ci_lower, arm.absolute_ci_upper);
}

function simultaneousIntervalForScale(
  arm: ArmResult,
  scale: PreRegistration["ship_rule"]["margin_scale"],
): Interval | null {
  if (scale === "relative") {
    if (arm.simultaneous_ci_lower === undefined || arm.simultaneous_ci_upper === undefined) {
      return null;
    }
    return finitePair(arm.simultaneous_ci_lower, arm.simultaneous_ci_upper);
  }
  if (
    arm.simultaneous_absolute_ci_lower === undefined ||
    arm.simultaneous_absolute_ci_upper === undefined
  ) {
    return null;
  }
  return finitePair(arm.simultaneous_absolute_ci_lower, arm.simultaneous_absolute_ci_upper);
}

function finitePair(lower: number | null, upper: number | null): Interval | null {
  if (lower === null || upper === null || !Number.isFinite(lower) || !Number.isFinite(upper)) {
    return null;
  }
  return { lower, upper };
}
