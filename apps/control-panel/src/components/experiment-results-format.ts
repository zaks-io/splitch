import type { ArmResult } from "@splitch/contracts";

/**
 * Shared number formatting for the Results tab, so the plot and the table can
 * never disagree about what a lift or an open interval bound reads as.
 */

export function formatLift(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "not estimable";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

export function formatInterval(result: Pick<ArmResult, "ci_lower" | "ci_upper">): string {
  return `[${formatBound(result.ci_lower, "−∞")}, ${formatBound(result.ci_upper, "+∞")}]`;
}

function formatBound(value: number | null, openLabel: string): string {
  if (value === null || !Number.isFinite(value)) return openLabel;
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}`;
}

/**
 * A p-value rendered so it cannot collapse across a decision boundary.
 *
 * Two-significant-digit rounding prints 0.0499 and 0.0501 identically as
 * "0.050", which hides which side of alpha a result landed on. Six significant
 * digits is far finer than any threshold anyone decides at, so the printed
 * value orders the same way the underlying one does.
 */
export function formatPValue(value: number): string {
  if (value < 0.0001) return "<0.0001";
  return String(Number(value.toPrecision(6)));
}

export type SignificanceDisplay = "significant" | "not_significant" | "inconsistent";

/**
 * What the row is allowed to claim about significance.
 *
 * ADR-0014: the interval a reader sees must be the interval the decision was
 * made on. When the engine flags significance but the plotted interval spans
 * zero, the two disagree, and the honest rendering is to say so rather than to
 * pick whichever one looks better.
 */
export function significanceDisplay(
  result: Pick<
    ArmResult,
    "ci_lower" | "ci_upper" | "is_significant" | "in_bh_family" | "decision_valid"
  >,
): SignificanceDisplay {
  if (!result.is_significant || !result.in_bh_family || !result.decision_valid) {
    return "not_significant";
  }
  return intervalSpansZero(result) ? "inconsistent" : "significant";
}

function intervalSpansZero(result: Pick<ArmResult, "ci_lower" | "ci_upper">): boolean {
  // An open or missing bound cannot exclude zero, so it spans it.
  const lower =
    result.ci_lower === null || !Number.isFinite(result.ci_lower) ? null : result.ci_lower;
  const upper =
    result.ci_upper === null || !Number.isFinite(result.ci_upper) ? null : result.ci_upper;
  if (lower === null && upper === null) return true;
  if (lower !== null && lower > 0) return false;
  if (upper !== null && upper < 0) return false;
  return true;
}
