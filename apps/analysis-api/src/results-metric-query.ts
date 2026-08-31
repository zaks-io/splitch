import type { MetricQueryConfig, StatsInput } from "@splitch/contracts";
import { ResultsInputError } from "./results-errors";
import { tinybirdDateTime64, type TinybirdReadTransport } from "./tinybird";

const METRIC_VALUES_PIPE = "analysis_metric_values_batch";
const PRE_PERIOD_PIPE = "analysis_pre_period_covariates_batch";

export async function readMetricRows(
  tinybird: TinybirdReadTransport,
  params: Record<string, string>,
  configs: readonly MetricQueryConfig[],
  startedAt: string,
  toTs: string,
  activationGated: boolean,
): Promise<readonly unknown[]> {
  if (configs.length === 0) return [];
  return tinybird.readPipe(
    METRIC_VALUES_PIPE,
    {
      ...params,
      metric_query_config: JSON.stringify(configs),
      activation_gated: activationGated ? "1" : "0",
      from_ts: tinybirdDateTime64(startedAt),
      to_ts: toTs,
    },
    { method: "POST" },
  );
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
  const eligibleConfigs = configs.filter((config) => config.metric_type !== "ratio");
  if (eligibleConfigs.length === 0) return [];
  const maxLookbackMs = Math.max(...eligibleConfigs.map((config) => config.cuped_lookback_ms));
  return tinybird.readPipe(
    PRE_PERIOD_PIPE,
    {
      ...params,
      metric_query_config: JSON.stringify(eligibleConfigs),
      from_ts: tinybirdDateTime64(new Date(startedAtMs - maxLookbackMs).toISOString()),
      to_ts: toTs,
    },
    { method: "POST" },
  );
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
