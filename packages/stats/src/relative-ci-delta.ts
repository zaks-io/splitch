import type { RelativeCiBounds } from "./relative-ci";
import type { CIResult } from "./sequential-ci";
import type { MetricComparisonEstimate } from "./variance-estimator-types";

/**
 * Delta-method relative-lift interval on the same sequential critical
 * multiplier the absolute decision already used.
 *
 * This is the Waudby-Smith Proposition 3.5-style comparator for the Fieller
 * audit (C11 / D1). It is not a production estimator: ADR-0015 rule 4 keeps
 * the published interval as the Fieller inversion of the absolute test.
 */
export function deltaMethodRelativeCi(
  comparison: MetricComparisonEstimate,
  decisionCi: CIResult,
): RelativeCiBounds | null {
  const relative = comparison.relative_lift_pct;
  const relativeVar = comparison.sampling_var;
  const absoluteVar = comparison.absolute_lift_sampling_var;
  if (
    relative === null ||
    relativeVar === null ||
    relativeVar <= 0 ||
    absoluteVar === null ||
    absoluteVar <= 0
  ) {
    return null;
  }

  const halfWidth = (decisionCi.ci_upper - decisionCi.ci_lower) / 2;
  if (!Number.isFinite(halfWidth) || halfWidth <= 0) {
    return {
      lower: Number.NEGATIVE_INFINITY,
      upper: Number.POSITIVE_INFINITY,
    };
  }

  const critical = halfWidth / Math.sqrt(absoluteVar);
  const standardError = Math.sqrt(relativeVar);
  const lower = relative - critical * standardError;
  const upper = relative + critical * standardError;
  if (Number.isNaN(lower) || Number.isNaN(upper)) {
    throw new Error(
      "delta-method relative interval produced NaN; the relative sampling variance or critical multiplier is undefined.",
    );
  }

  return { lower, upper };
}
