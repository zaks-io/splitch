import type { ArmResult, StatsOutput } from "./stats-result-contract";

/**
 * The Run's unified decision family.
 *
 * BH correction runs over top-level goal Metrics *and* Primary Dimension slices
 * (docs/spec/stats/dimension-slicing.md), so readiness has to read both. A check
 * that looked only at `arm_results` would block a Run whose decision family
 * lives in a Primary Dimension, and would let an estimator failure inside a
 * slice pass without ever being named.
 *
 * Secondary Dimensions are excluded on purpose: the spec reports them
 * uncorrected, `exploratory`, and never `decision_valid`, so they are
 * hypotheses and cannot carry or block a decision.
 */
export interface DecisionFamilyMember {
  readonly result: ArmResult;
  /** Identifies the slice as well as the Metric, so a refusal names the real source. */
  readonly label: string;
}

function decisionFamily(stats: StatsOutput): DecisionFamilyMember[] {
  return [...topLevelMembers(stats), ...primaryDimensionMembers(stats)];
}

export function decisionValidMembers(stats: StatsOutput): DecisionFamilyMember[] {
  return decisionFamily(stats).filter((member) => member.result.decision_valid);
}

export function lockedFamilyMembers(stats: StatsOutput): DecisionFamilyMember[] {
  return decisionFamily(stats).filter(
    (member) => member.result.in_bh_family && member.result.decision_valid,
  );
}

export function named(members: readonly DecisionFamilyMember[]): string {
  return members.map((member) => member.label).join(", ");
}

function topLevelMembers(stats: StatsOutput): DecisionFamilyMember[] {
  return stats.arm_results.map((result) => ({ result, label: metricLabel(result) }));
}

function primaryDimensionMembers(stats: StatsOutput): DecisionFamilyMember[] {
  return (stats.dimension_results ?? [])
    .filter((dimension) => dimension.class === "primary")
    .flatMap((dimension) =>
      dimension.arm_results.map((result) => ({
        result,
        label: `${metricLabel(result)} [${dimension.dimension_id}=${dimension.dimension_value}]`,
      })),
    );
}

function metricLabel(result: ArmResult): string {
  return `${result.metric_id} / ${result.variant}`;
}
