import type { ArmResult, Metric } from "@splitch/contracts";

/**
 * Estimate formatting for the Metric comparison. Rates read as percentages and
 * their differences as percentage points; every other kind reads in its
 * recorded unit, which the Metric contract does not name, so none is invented.
 */

export function comparisonUnavailableReason(
  arm: ArmResult | undefined,
  kind: Metric["kind"] | undefined,
): string | null {
  if (!arm) return "No analysis result returned";
  if (arm.sample_size_n === 0) return "No observations yet";
  // The engine encodes a missing ratio estimate as zero, and its status also covers comparison failures.
  if (kind !== "binomial" && arm.status === "insufficient_denominator" && arm.point_estimate === 0)
    return "Estimate unresolved: insufficient denominator";
  if (kind === undefined) return "Estimate unavailable: Metric type missing";
  return null;
}

export function formatComparisonEstimate(value: number, kind: Metric["kind"]): string {
  return kind === "binomial" ? `${formatNumber(value * 100)}%` : formatNumber(value);
}

export function formatAbsoluteDifference(
  arm: ArmResult,
  control: ArmResult,
  kind: Metric["kind"],
): string {
  const difference = arm.point_estimate - control.point_estimate;
  const sign = difference > 0 ? "+" : "";
  return kind === "binomial"
    ? `${sign}${formatNumber(difference * 100)} pp`
    : `${sign}${formatNumber(difference)}`;
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US", { maximumSignificantDigits: 4 });
}
