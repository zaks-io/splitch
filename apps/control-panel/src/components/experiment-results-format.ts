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
