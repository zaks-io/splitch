import { z } from "zod";
import type { ArmResult, StatsOutput } from "./stats-result-contract";

/**
 * What a surface is allowed to claim about a result's significance.
 *
 * ADR-0014: the interval a reader sees must be the interval the decision was
 * made on. When the engine flags significance but the plotted relative-lift
 * interval spans zero, the two were decided on different scales, and the honest
 * rendering is to say so rather than to pick whichever one looks better.
 *
 * ADR-0030 puts that judgement here rather than in the browser. A skin that
 * recomputed it would be doing statistics client-side, and two skins could then
 * disagree about the same Run.
 */
export const significanceDisplays = ["significant", "not_significant", "inconsistent"] as const;
export const SignificanceDisplaySchema = z.enum(significanceDisplays);
export type SignificanceDisplay = z.infer<typeof SignificanceDisplaySchema>;

/** Keyed by Metric and Variant so a surface can look up the row it is drawing. */
export const ExperimentSignificanceDisplaysSchema = z.record(z.string(), SignificanceDisplaySchema);
export type ExperimentSignificanceDisplays = z.infer<typeof ExperimentSignificanceDisplaysSchema>;

export function significanceKey(result: Pick<ArmResult, "metric_id" | "variant">): string {
  return `${result.metric_id}/${result.variant}`;
}

export function significanceDisplayFor(
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

export function experimentSignificanceDisplays(stats: StatsOutput): ExperimentSignificanceDisplays {
  const displays: Record<string, SignificanceDisplay> = {};
  for (const result of stats.arm_results) {
    displays[significanceKey(result)] = significanceDisplayFor(result);
  }
  return displays;
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
