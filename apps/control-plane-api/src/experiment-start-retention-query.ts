import { DEFAULT_CUPED_LOOKBACK_MS, type MetricQueryConfig } from "@splitch/contracts";
import type { Repository } from "@splitch/db";
import { experimentStartInvalid } from "./experiment-errors";

type MetricRow = NonNullable<Awaited<ReturnType<Repository["experiments"]["getMetric"]>>>;
type Result<T> = { ok: true; value: T } | { ok: false; response: Response };

/**
 * Freeze a Retention Metric as a horizon-gated Binomial query: the existing
 * pipe's window is [anchor + offset, anchor + offset + duration).
 */
export function retentionQueryConfig(row: MetricRow, requestId: string): Result<MetricQueryConfig> {
  if (!row.eventDefinitionId) {
    return invalidRetention(row.id, "has no Event Definition", requestId);
  }
  const start = row.horizonStartMs;
  const end = row.horizonEndMs;
  if (start == null || end == null) {
    return invalidRetention(row.id, "requires horizonStartMs and horizonEndMs", requestId);
  }
  if (end <= start) {
    return invalidRetention(row.id, "horizonEndMs must be greater than horizonStartMs", requestId);
  }
  return {
    ok: true,
    value: {
      metric_id: row.id,
      metric_type: "retention",
      event_definition_id: row.eventDefinitionId,
      event_field_name: null,
      window_offset_ms: start,
      window_duration_ms: end - start,
      horizon_start_ms: start,
      horizon_end_ms: end,
      cuped_lookback_ms: DEFAULT_CUPED_LOOKBACK_MS,
    },
  };
}

function invalidRetention(metricId: string, message: string, requestId: string): Result<never> {
  return {
    ok: false,
    response: experimentStartInvalid(
      [{ path: ["body", "metrics", metricId], message: `Metric ${metricId} ${message}` }],
      requestId,
    ),
  };
}
