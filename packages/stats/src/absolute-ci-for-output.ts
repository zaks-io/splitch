import type { CIResult } from "./sequential-ci";

/**
 * Absolute decision-interval bounds for Treatment arms. Published beside the
 * relative CI so the Control Plane ship recommendation can judge absolute
 * margins without importing the stats engine. Stripped from the result token.
 */

export function absoluteCiForOutput(
  decisionCi: CIResult | null,
): { absolute_ci_lower: number; absolute_ci_upper: number } | Record<string, never> {
  if (
    decisionCi === null ||
    !Number.isFinite(decisionCi.ci_lower) ||
    !Number.isFinite(decisionCi.ci_upper)
  ) {
    return {};
  }
  return {
    absolute_ci_lower: decisionCi.ci_lower,
    absolute_ci_upper: decisionCi.ci_upper,
  };
}
