import {
  DEFAULT_CUPED_LOOKBACK_MS,
  type MetricKind,
  type MetricQueryConfig,
} from "@splitch/contracts";
import type { Repository } from "@splitch/db";
import { experimentStartInvalid } from "./experiment-errors";

type MetricRow = NonNullable<Awaited<ReturnType<Repository["experiments"]["getMetric"]>>>;
type Result<T> = { ok: true; value: T } | { ok: false; response: Response };

export function binomialQueryConfig(
  row: MetricRow,
  metricType: MetricKind,
  conversionWindowMs: number,
  requestId: string,
): Result<MetricQueryConfig> {
  if (metricType === "retention") {
    throw new Error(`prepareStart: Retention Metric ${row.id} escaped its branch`);
  }
  if (metricType !== "binomial") {
    return {
      ok: false,
      response: experimentStartInvalid(
        [
          {
            path: ["body", "metrics", row.id],
            message: `Metric ${row.id} has unsupported kind ${metricType}`,
          },
        ],
        requestId,
      ),
    };
  }
  if (!row.eventDefinitionId) {
    return {
      ok: false,
      response: experimentStartInvalid(
        [
          {
            path: ["body", "metrics", row.id],
            message: `Metric ${row.id} has no Event Definition`,
          },
        ],
        requestId,
      ),
    };
  }
  return {
    ok: true,
    value: {
      metric_id: row.id,
      metric_type: "binomial",
      event_definition_id: row.eventDefinitionId,
      event_field_name: null,
      window_duration_ms: conversionWindowMs,
      cuped_lookback_ms: DEFAULT_CUPED_LOOKBACK_MS,
    },
  };
}
