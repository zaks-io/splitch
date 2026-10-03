import type { StatsInput } from "@splitch/contracts";
import { fiellerRelativeCi } from "./relative-ci";
import type { CIAdapter, CIResult } from "./sequential-ci";
import type { MetricComparisonEstimate } from "./variance-estimator-types";

/**
 * Bonferroni simultaneous intervals for ship-rule margin clearance when the
 * freeze combines k > 1 locked goal Metrics (unanimous_goals / any_goal).
 * Recomputes the decision CI at alpha/k with the same adapter; never rescales
 * the ordinary alpha interval. Omitted when k <= 1 or primary_wins.
 */

export type SimultaneousShipMarginCi =
  | {
      simultaneous_absolute_ci_lower: number;
      simultaneous_absolute_ci_upper: number;
      simultaneous_ci_lower?: number;
      simultaneous_ci_upper?: number;
    }
  | Record<string, never>;

export function shipMarginGoalCount(input: StatsInput): number {
  const resolution = input.pre_registration?.ship_rule.conflict_resolution;
  if (resolution !== "unanimous_goals" && resolution !== "any_goal") {
    return 1;
  }
  const count = new Set(input.decision_family.map((member) => member.metric_id)).size;
  return count > 0 ? count : 1;
}

export function simultaneousShipMarginCiForOutput(input: {
  statsInput: StatsInput;
  comparison: MetricComparisonEstimate;
  adapters: { sequentialCI: CIAdapter; fixedHorizonCI: CIAdapter };
}): SimultaneousShipMarginCi {
  const goalCount = shipMarginGoalCount(input.statsInput);
  if (goalCount <= 1) return {};

  const alpha = 1 - input.statsInput.confidence_level;
  const simultaneous = decisionCiAtAlpha({
    statsInput: input.statsInput,
    comparison: input.comparison,
    adapters: input.adapters,
    alpha: alpha / goalCount,
  });
  if (
    simultaneous === null ||
    !Number.isFinite(simultaneous.ci_lower) ||
    !Number.isFinite(simultaneous.ci_upper)
  ) {
    return {};
  }

  const absolute = {
    simultaneous_absolute_ci_lower: simultaneous.ci_lower,
    simultaneous_absolute_ci_upper: simultaneous.ci_upper,
  };

  if (input.statsInput.pre_registration?.ship_rule.margin_scale !== "relative") {
    return absolute;
  }

  const relative = relativeBoundsFor(input.comparison, simultaneous);
  if (relative === null) return absolute;
  return {
    ...absolute,
    simultaneous_ci_lower: relative.lower,
    simultaneous_ci_upper: relative.upper,
  };
}

function decisionCiAtAlpha(input: {
  statsInput: StatsInput;
  comparison: MetricComparisonEstimate;
  adapters: { sequentialCI: CIAdapter; fixedHorizonCI: CIAdapter };
  alpha: number;
}): CIResult | null {
  if (
    input.comparison.control.status !== "ready" ||
    input.comparison.treatment.status !== "ready" ||
    input.comparison.absolute_lift === null ||
    input.comparison.absolute_lift_sampling_var === null
  ) {
    return null;
  }
  const adapter =
    input.statsInput.horizon === "fixed"
      ? input.adapters.fixedHorizonCI
      : input.adapters.sequentialCI;
  return adapter.compute({
    estimate: input.comparison.absolute_lift,
    sampling_var: input.comparison.absolute_lift_sampling_var,
    n_t: input.comparison.treatment.sample_size_n,
    n_c: input.comparison.control.sample_size_n,
    alpha: input.alpha,
    target_n: input.statsInput.target_n,
    sample_size_locked: input.statsInput.sample_size_locked,
  });
}

function relativeBoundsFor(
  comparison: MetricComparisonEstimate,
  decisionCi: CIResult,
): { lower: number; upper: number } | null {
  if (comparison.relative_lift_pct === null) return null;
  const bounds = fiellerRelativeCi(comparison, decisionCi);
  if (!Number.isFinite(bounds.lower) || !Number.isFinite(bounds.upper)) return null;
  return bounds;
}
