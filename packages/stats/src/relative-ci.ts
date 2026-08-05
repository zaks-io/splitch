import type { CIResult } from "./sequential-ci";
import type { MetricComparisonEstimate } from "./variance-estimator-types";

export interface RelativeCiBounds {
  readonly lower: number;
  readonly upper: number;
}

/**
 * An unbounded decision interval, or a Control mean too close to zero to pin
 * the ratio down, has to stay unbounded here. Collapsing it to a null bound
 * would read as a missing interval rather than an infinitely wide one.
 */
const UNBOUNDED: RelativeCiBounds = {
  lower: Number.NEGATIVE_INFINITY,
  upper: Number.POSITIVE_INFINITY,
};

/**
 * Fieller (1954) interval for the ratio of the two arm means, published as a
 * relative lift percentage.
 *
 * ADR-0014 requires that the interval a reader sees be the interval the
 * decision was made on. The absolute-lift interval is the decision, so the
 * relative interval has to be derived from it rather than estimated a second
 * time by the delta method: two independent estimates straddle zero at
 * different points, which is how a Run could read "not significant" beside an
 * interval sitting entirely below zero.
 *
 * Fieller derives it exactly. Substituting a ratio of 1 into the quadratic
 * below reduces it to (T - C)^2 <= k^2 (vT + vC), which is precisely the
 * absolute test, so the published interval contains 0% lift if and only if the
 * decision interval contains zero. Dividing the absolute bounds by the Control
 * mean would also be consistent, but it treats that mean as known and so
 * publishes an interval that is too narrow, which under-fires Guardrails.
 *
 * The critical multiplier is recovered from the decision interval's own
 * half-width, so this tracks whichever adapter produced it (the fixed-horizon
 * critical value or the sequential boundary) instead of assuming a z. The arm
 * variances come from absolute_lift_var_components for the same reason: they
 * are the two halves the decision interval was actually built on.
 */
export function fiellerRelativeCi(
  comparison: MetricComparisonEstimate,
  decisionCi: CIResult,
): RelativeCiBounds {
  const controlPoint = comparison.control.point_estimate;
  const treatmentPoint = comparison.treatment.point_estimate;
  const components = comparison.absolute_lift_var_components;
  const absoluteVar = comparison.absolute_lift_sampling_var;
  const halfWidth = (decisionCi.ci_upper - decisionCi.ci_lower) / 2;

  if (
    controlPoint === null ||
    treatmentPoint === null ||
    components === null ||
    absoluteVar === null ||
    absoluteVar <= 0 ||
    !Number.isFinite(halfWidth) ||
    halfWidth <= 0
  ) {
    return UNBOUNDED;
  }

  const criticalSquared = halfWidth ** 2 / absoluteVar;

  const a = controlPoint ** 2 - criticalSquared * components.control;
  const b = -2 * treatmentPoint * controlPoint;
  const c = treatmentPoint ** 2 - criticalSquared * components.treatment;

  // a <= 0 means the Control mean is not itself separated from zero at this
  // level, so no bounded interval for the ratio exists. A Control mean of
  // exactly zero lands here too, since a is then -k^2 vC.
  if (a <= 0) {
    return UNBOUNDED;
  }

  // b^2 - 4ac reduces to 4k^2 (C^2 vT + T^2 vC - k^2 vC vT), and a > 0 means
  // C^2 > k^2 vC, so C^2 vT alone already dominates k^2 vC vT. The discriminant
  // cannot be negative past this point and the clamp only absorbs the rounding
  // noise around an exact zero, where Math.sqrt would otherwise return NaN.
  const discriminant = b ** 2 - 4 * a * c;
  const root = Math.sqrt(Math.max(discriminant, 0));
  const first = (-b - root) / (2 * a);
  const second = (-b + root) / (2 * a);

  return {
    lower: (Math.min(first, second) - 1) * 100,
    upper: (Math.max(first, second) - 1) * 100,
  };
}
