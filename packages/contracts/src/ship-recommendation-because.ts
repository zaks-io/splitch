import type { MetricDirection } from "./leaf-schemas-experiment";
import type { RopeScale } from "./run-preregistration";
import type { MetricEffectVerdict } from "./ship-recommendation-effect";

/** Format helpers for the one-sentence `because`. Numbers only; no Metric ids. */

function formatInterval(lower: number, upper: number, scale: RopeScale): string {
  return `[${formatBound(lower, scale)}, ${formatBound(upper, scale)}]`;
}

function formatBound(value: number, scale: RopeScale): string {
  if (scale === "relative") {
    return `${trimNumber(value)}%`;
  }
  return trimNumber(value);
}

function formatMargin(marginOnScale: number, scale: RopeScale): string {
  return scale === "relative" ? `${trimNumber(marginOnScale)}%` : trimNumber(marginOnScale);
}

export function effectBecause(input: {
  effect: MetricEffectVerdict;
  desirability: MetricDirection;
  scale: RopeScale;
  ciLower: number;
  ciUpper: number;
  marginOnScale: number;
  relativeLiftPct: number | null;
}): string {
  const interval = formatInterval(input.ciLower, input.ciUpper, input.scale);
  const margin = formatMargin(input.marginOnScale, input.scale);
  const direction =
    input.desirability === "higher_is_better" ? "higher-is-better" : "lower-is-better";

  if (input.effect === "harmful") {
    if (
      input.desirability === "lower_is_better" &&
      input.relativeLiftPct !== null &&
      input.relativeLiftPct > 0
    ) {
      return `Primary Metric shows a positive lift of ${trimNumber(input.relativeLiftPct)}% (interval ${interval}) against a ${direction} goal.`;
    }
    return `Primary Metric interval ${interval} shows harm for a ${direction} goal.`;
  }
  if (input.effect === "beneficial") {
    return `Primary Metric interval ${interval} clears the required ${margin} margin for a ${direction} goal.`;
  }
  return `Primary Metric interval ${interval} has not cleared the required ${margin} margin.`;
}

export function guardrailBecause(input: {
  ciLower: number | null;
  threshold: number;
  breachReason: string | null;
}): string {
  if (input.breachReason !== null && input.breachReason.trim() !== "") {
    // Breach reasons from the engine already name the bound and threshold.
    return `A Guardrail is breached: ${input.breachReason}`;
  }
  if (input.ciLower === null) {
    return "A Guardrail is breached.";
  }
  return `A Guardrail is breached: relative lift lower bound ${trimNumber(input.ciLower)}% is below the ${trimNumber(input.threshold)}% threshold.`;
}

function trimNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const fixed = value.toPrecision(6);
  return String(Number(fixed));
}
