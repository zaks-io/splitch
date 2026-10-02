import type {
  ArmResult,
  EstimandDisclosure,
  EstimandLabel,
  MetricKind,
  UncappedEstimate,
} from "@splitch/contracts";

/** The cap's effect on one arm: how many Entities it lowered and the uncapped result. */
export interface CappedArmEvidence {
  readonly capped_entity_count: number;
  readonly uncapped: ArmResult;
}

/**
 * Name the published estimate and, when the cap applied, disclose the uncapped
 * one beside it. The published (capped) estimate is the one decisions use; the
 * uncapped estimate never enters the decision family.
 */
export function estimandDisclosure(
  metricType: MetricKind,
  capped: CappedArmEvidence | null,
): EstimandDisclosure {
  const label = estimandLabel(metricType, capped !== null);
  if (capped === null) {
    return { label, decision_label: label, capped_entity_count: null, uncapped: null };
  }
  return {
    label,
    decision_label: label,
    capped_entity_count: capped.capped_entity_count,
    uncapped: uncappedEstimate(metricType, capped.uncapped),
  };
}

function estimandLabel(metricType: MetricKind, capped: boolean): EstimandLabel {
  switch (metricType) {
    case "binomial":
      if (capped) {
        throw new Error("a Binomial Metric is never winsorized.");
      }
      return "binomial_mean";
    case "ratio":
      return capped ? "ratio_of_capped_means" : "ratio_of_uncapped_means";
    case "count":
    case "revenue":
      return capped ? "capped_additive_mean" : "uncapped_additive_mean";
    default:
      throw new Error(`no estimand label for Metric kind ${metricType satisfies never}.`);
  }
}

function uncappedEstimate(metricType: MetricKind, arm: ArmResult): UncappedEstimate {
  return {
    label: estimandLabel(metricType, false),
    point_estimate: arm.point_estimate,
    relative_lift_pct: arm.relative_lift_pct,
    ci_lower: arm.ci_lower,
    ci_upper: arm.ci_upper,
    p_value: arm.p_value,
    status: arm.status,
    cuped_applied: arm.variance_techniques.cuped_applied,
  };
}
