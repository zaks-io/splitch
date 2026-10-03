import type { MetricKind, StatsInput } from "@splitch/contracts";

// StatsInput does not carry Metric definitions; zero-row non-ratio Metrics all seed the same
// zero-valued exposed Entities, so this type is only a safe bootstrap for locked empty Metrics
// that were never frozen as Retention.
const ZERO_EVENT_NON_RATIO_METRIC_TYPE: MetricKind = "binomial";

export function metricTypesById(input: StatsInput): Map<string, MetricKind> {
  const byId = new Map<string, MetricKind>();

  for (const horizon of input.metric_retention_horizons ?? []) {
    setMetricType(byId, horizon.metric_id, "retention");
  }

  for (const row of input.metric_values) {
    if (row.run_id !== input.run_id) {
      continue;
    }
    setMetricType(byId, row.metric_id, row.metric_type);
  }

  for (const metricId of lockedMetricIds(input)) {
    if (!byId.has(metricId)) {
      byId.set(metricId, ZERO_EVENT_NON_RATIO_METRIC_TYPE);
    }
  }

  return new Map([...byId.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function setMetricType(
  byId: Map<string, MetricKind>,
  metricId: string,
  metricType: MetricKind,
): void {
  const existing = byId.get(metricId);
  if (existing !== undefined && existing !== metricType) {
    throw new Error(`metric ${metricId} mixed ${existing} and ${metricType}.`);
  }
  byId.set(metricId, metricType);
}

function lockedMetricIds(input: StatsInput): string[] {
  return [
    ...new Set([
      ...input.decision_family.map((member) => member.metric_id),
      ...input.guardrail_decisions.map((guardrail) => guardrail.metric_id),
    ]),
  ];
}
