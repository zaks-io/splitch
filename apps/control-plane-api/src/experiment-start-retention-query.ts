import { DEFAULT_CUPED_LOOKBACK_MS, type MetricQueryConfig } from "@splitch/contracts";
import {
  invalidMetric,
  type MetricRow,
  type PublishedSource,
  type Result,
  sourceEventDefinitionVersion,
  sourceVersionIssue,
} from "./experiment-start-metric-source";

/**
 * Freeze a Retention Metric as a horizon-gated Binomial query: the existing
 * pipe's window is [anchor + offset, anchor + offset + duration).
 */
export function retentionStartQueryConfig(
  sources: Map<string, PublishedSource>,
  row: MetricRow,
  targetingKeyType: string,
  requestId: string,
): Result<MetricQueryConfig> {
  const source = sourceEventDefinitionVersion(sources, row, row.id, requestId);
  if (!source.ok) return source;
  const versionIssue = sourceVersionIssue(row, source.value, targetingKeyType, row.id, requestId);
  if (versionIssue) return versionIssue;
  return retentionQueryConfig(row, requestId);
}

function retentionQueryConfig(row: MetricRow, requestId: string): Result<MetricQueryConfig> {
  if (!row.eventDefinitionId) {
    return invalidMetric(row.id, "has no Event Definition", requestId);
  }
  const start = row.horizonStartMs;
  const end = row.horizonEndMs;
  if (start == null || end == null) {
    return invalidMetric(row.id, "requires horizonStartMs and horizonEndMs", requestId);
  }
  if (end <= start) {
    return invalidMetric(row.id, "horizonEndMs must be greater than horizonStartMs", requestId);
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
