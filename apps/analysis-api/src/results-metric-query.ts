import type { MetricQueryConfig, StatsInput } from "@splitch/contracts";
import { ResultsInputError } from "./results-errors";
import { tinybirdDateTime64, type TinybirdReadTransport } from "./tinybird";

const METRIC_VALUES_PIPE = "analysis_metric_values";
const PRE_PERIOD_PIPE = "analysis_pre_period_covariates";

export async function readMetricRows(
  tinybird: TinybirdReadTransport,
  params: Record<string, string>,
  configs: readonly MetricQueryConfig[],
  startedAt: string,
  toTs: string,
): Promise<readonly unknown[]> {
  const rows = await Promise.all(
    configs.map((config) => {
      assertBinomialQuery(config);
      return tinybird.readPipe(METRIC_VALUES_PIPE, {
        ...params,
        metric_id: config.metric_id,
        event_definition_id: config.event_definition_id,
        window_duration_ms: String(config.window_duration_ms),
        from_ts: tinybirdDateTime64(startedAt),
        to_ts: toTs,
      });
    }),
  );
  return rows.flat();
}

export async function readPrePeriodRows(
  tinybird: TinybirdReadTransport,
  params: Record<string, string>,
  configs: readonly MetricQueryConfig[],
  startedAt: string,
  toTs: string,
): Promise<readonly unknown[]> {
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs)) {
    throw new ResultsInputError("analysis_run_inputs.started_at is not a timestamp");
  }
  const rows = await Promise.all(
    configs.map((config) => {
      assertBinomialQuery(config);
      return tinybird.readPipe(PRE_PERIOD_PIPE, {
        ...params,
        metric_id: config.metric_id,
        event_definition_id: config.event_definition_id,
        lookback_ms: String(config.cuped_lookback_ms),
        from_ts: tinybirdDateTime64(new Date(startedAtMs - config.cuped_lookback_ms).toISOString()),
        to_ts: toTs,
      });
    }),
  );
  return rows.flat();
}

export function assertMetricQueryCoverage(
  run: Pick<StatsInput, "decision_family" | "guardrail_decisions">,
  configs: readonly MetricQueryConfig[],
): void {
  const analyzed = new Set([
    ...run.decision_family.map((member) => member.metric_id),
    ...(run.guardrail_decisions ?? []).map((member) => member.metric_id),
  ]);
  const configured = new Set<string>();
  for (const config of configs) {
    if (configured.has(config.metric_id)) {
      throw new ResultsInputError(`metric_query_config duplicates Metric ${config.metric_id}`);
    }
    configured.add(config.metric_id);
  }
  const missing = [...analyzed].filter((metricId) => !configured.has(metricId));
  if (missing.length > 0) {
    throw new ResultsInputError(
      `metric_query_config is missing analyzed Metrics: ${missing.sort().join(", ")}; re-Start the Run`,
    );
  }
}

function assertBinomialQuery(config: MetricQueryConfig): void {
  if (config.metric_type !== "binomial") {
    throw new ResultsInputError(
      `analysis materialization for ${config.metric_type} Metric ${config.metric_id} is unavailable`,
    );
  }
}
