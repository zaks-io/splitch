import type { Metric } from "@splitch/contracts";

/**
 * Metric display names for the Results tab. Analysis payloads carry raw Metric
 * ids; the Panel resolves them against the App-level Metric catalog the detail
 * read already returns, so an operator never reads `metric_…` where a name
 * exists.
 */

export type MetricNames = ReadonlyMap<string, string>;

export function metricNamesById(metrics: readonly Pick<Metric, "id" | "name">[]): MetricNames {
  return new Map(metrics.map((metric) => [metric.id, metric.name]));
}

/**
 * A Metric deleted after the Run froze has no name left to show; the raw id is
 * the only truthful identifier, so it renders as-is rather than as a guess.
 */
export function metricDisplayName(metricId: string, names: MetricNames): string {
  return names.get(metricId) ?? metricId;
}

/** Gate check details arrive as prose with raw Metric ids embedded; rewrite them. */
export function withMetricNames(text: string, names: MetricNames): string {
  let renamed = text;
  for (const [id, name] of names) renamed = renamed.replaceAll(id, name);
  return renamed;
}
