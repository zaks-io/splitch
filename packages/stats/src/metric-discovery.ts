import type { MetricKind, StatsInput } from "@splitch/contracts";

// StatsInput does not carry Metric definitions; zero-row non-ratio Metrics all seed the same
// zero-valued exposed Entities, so this type is only a safe bootstrap for locked empty Metrics.
const ZERO_EVENT_NON_RATIO_METRIC_TYPE: MetricKind = "binomial";

export function metricTypesById(input: StatsInput): Map<string, MetricKind> {
  const byId = new Map<string, MetricKind>();

  for (const row of input.metric_values) {
    if (row.run_id !== input.run_id) {
      continue;
    }

    const existing = byId.get(row.metric_id);
    if (existing !== undefined && existing !== row.metric_type) {
      throw new Error(`metric ${row.metric_id} mixed ${existing} and ${row.metric_type}.`);
    }
    byId.set(row.metric_id, row.metric_type);
  }
  for (const metricId of lockedMetricIds(input)) {
    if (!byId.has(metricId)) {
      byId.set(metricId, ZERO_EVENT_NON_RATIO_METRIC_TYPE);
    }
  }

  return new Map([...byId.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function lockedMetricIds(input: StatsInput): string[] {
  return [
    ...new Set([
      ...input.decision_family.map((member) => member.metric_id),
      ...input.guardrail_decisions.map((guardrail) => guardrail.metric_id),
    ]),
  ];
}
