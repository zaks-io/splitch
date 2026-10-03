import type { ArmResult, PreRegistration, PreRegistrationMetric } from "@splitch/contracts";
import { classifyMdeExclusionFutility } from "./futility-verdict";
import type { CIResult } from "./sequential-ci";

/**
 * Attach futilityVerdict / futilityBecause when pre-registration froze
 * `futility: "mde_exclusion"` for the primary Metric with an absolute MDE and
 * the absolute decision interval is finite. Off, non-primary, missing MDE, or
 * a non-finite interval omit both fields (never defaulted). Advisory only.
 */

export function withFutilityVerdict(
  arm: ArmResult,
  input: {
    preRegistration: PreRegistration | undefined;
    decisionCi: CIResult | null;
  },
): ArmResult {
  const preRegistration = input.preRegistration;
  if (preRegistration === undefined || preRegistration.futility !== "mde_exclusion") {
    return arm;
  }
  if (arm.metric_id !== preRegistration.primary_metric_id) return arm;

  const primary = primaryMetric(preRegistration);
  if (primary?.mde_absolute === undefined) return arm;

  const interval = absoluteInterval(input.decisionCi);
  if (interval === null) return arm;

  const classified = classifyMdeExclusionFutility({
    lower: interval.lower,
    upper: interval.upper,
    mdeAbsolute: primary.mde_absolute,
    desirability: primary.desirability,
  });
  return {
    ...arm,
    futilityVerdict: classified.verdict,
    futilityBecause: classified.because,
  };
}

function primaryMetric(preRegistration: PreRegistration): PreRegistrationMetric | undefined {
  return preRegistration.metrics.find(
    (metric) => metric.metric_id === preRegistration.primary_metric_id,
  );
}

function absoluteInterval(decisionCi: CIResult | null): { lower: number; upper: number } | null {
  if (
    decisionCi === null ||
    !Number.isFinite(decisionCi.ci_lower) ||
    !Number.isFinite(decisionCi.ci_upper)
  ) {
    return null;
  }
  return { lower: decisionCi.ci_lower, upper: decisionCi.ci_upper };
}
