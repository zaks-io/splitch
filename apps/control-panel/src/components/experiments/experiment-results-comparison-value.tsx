import type { ArmResult, Metric } from "@splitch/contracts";

export function ExperimentResultsComparisonValue({
  arm,
  control,
  kind,
  difference = false,
}: {
  arm: ArmResult | undefined;
  control?: ArmResult;
  kind: Metric["kind"] | undefined;
  difference?: boolean;
}) {
  const reason = unavailableReason(arm, kind);
  const controlReason = difference ? unavailableReason(control, kind) : null;
  const missing = reason ?? (controlReason ? `Baseline: ${controlReason}` : null);
  const value = missing ? null : estimateValue(arm, control, kind, difference);
  return (
    <td className="px-4 py-3 text-right font-mono tabular-nums">
      {missing ? <span className="font-sans text-muted-foreground text-xs">{missing}</span> : value}
      {!missing && arm?.status === "error" ? (
        <span className="block font-sans text-muted-foreground text-xs">
          Confidence interval unavailable
        </span>
      ) : null}
    </td>
  );
}

function estimateValue(
  arm: ArmResult | undefined,
  control: ArmResult | undefined,
  kind: Metric["kind"] | undefined,
  difference: boolean,
): string {
  if (!arm) throw new Error("Missing metric estimate");
  if (!difference) return formatEstimate(arm.point_estimate, kind, false);
  if (!control) throw new Error("Difference requires a baseline estimate");
  return formatEstimate(arm.point_estimate - control.point_estimate, kind, true);
}

function unavailableReason(
  arm: ArmResult | undefined,
  kind: Metric["kind"] | undefined,
): string | null {
  if (!arm) return "No analysis result returned";
  if (arm.sample_size_n === 0) return "No observations yet";
  // The engine encodes a missing ratio estimate as zero, and its status also covers comparison failures.
  if (kind !== "binomial" && arm.status === "insufficient_denominator" && arm.point_estimate === 0)
    return "Estimate unresolved: insufficient denominator";
  return null;
}

function formatEstimate(
  value: number,
  kind: Metric["kind"] | undefined,
  difference: boolean,
): string {
  const rate = kind === "binomial";
  const formatted = (rate ? value * 100 : value).toLocaleString("en-US", {
    maximumSignificantDigits: 5,
  });
  return `${difference && value > 0 ? "+" : ""}${formatted}${rate ? (difference ? " pp" : "%") : ""}`;
}
