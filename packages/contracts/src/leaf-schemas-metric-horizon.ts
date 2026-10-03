import type { z } from "zod";

/**
 * Retention Metric horizon: retained = a qualifying event in
 * [anchor + horizonStartMs, anchor + horizonEndMs). The same Conversion Window
 * anchor applies (first Exposure, or Activation when the Run is gated).
 */
export function metricHorizonIssue(metric: {
  readonly kind: string;
  readonly horizonStartMs?: number | null;
  readonly horizonEndMs?: number | null;
}): string | null {
  const start = metric.horizonStartMs;
  const end = metric.horizonEndMs;
  const hasStart = start != null;
  const hasEnd = end != null;
  if (metric.kind !== "retention") {
    return hasStart || hasEnd
      ? "only a Retention Metric may set horizonStartMs / horizonEndMs"
      : null;
  }
  if (!hasStart || !hasEnd) {
    return "retention Metric requires horizonStartMs and horizonEndMs";
  }
  if (end <= start) {
    return "horizonEndMs must be greater than horizonStartMs";
  }
  return null;
}

export function applyMetricHorizonRefine(
  metric: {
    readonly kind: string;
    readonly horizonStartMs?: number | null;
    readonly horizonEndMs?: number | null;
  },
  context: z.RefinementCtx,
): void {
  const issue = metricHorizonIssue(metric);
  if (issue === null) return;
  context.addIssue({ code: "custom", message: issue });
}
