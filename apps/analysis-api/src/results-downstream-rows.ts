import type { MetricQueryConfig } from "@splitch/contracts";
import { readMetricRows, readPrePeriodRows } from "./results-metric-query";
import type { TinybirdReadTransport } from "./tinybird";

const ACTIVATION_PIPE = "analysis_activation_rows";

interface DownstreamAnalysisRowsInput {
  tinybird: TinybirdReadTransport;
  params: Record<string, string>;
  metricQueryConfig: readonly MetricQueryConfig[];
  startedAt: string;
  toTs: string;
  activationGated: boolean;
  hasAnalyzedMetrics: boolean;
}

interface DownstreamAnalysisRows {
  metricRows: readonly unknown[];
  prePeriodRows: readonly unknown[];
  activationRows: readonly unknown[];
}

export async function readDownstreamAnalysisRows(
  input: DownstreamAnalysisRowsInput,
): Promise<DownstreamAnalysisRows> {
  if (!input.hasAnalyzedMetrics) {
    return { metricRows: [], prePeriodRows: [], activationRows: [] };
  }
  const activationRows = input.activationGated
    ? input.tinybird.readPipe(ACTIVATION_PIPE, input.params)
    : Promise.resolve([]);
  const [metricRows, prePeriodRows, resolvedActivationRows] = await Promise.all([
    readMetricRows(
      input.tinybird,
      input.params,
      input.metricQueryConfig,
      input.startedAt,
      input.toTs,
      input.activationGated,
    ),
    readPrePeriodRows(
      input.tinybird,
      input.params,
      input.metricQueryConfig,
      input.startedAt,
      input.toTs,
    ),
    activationRows,
  ]);
  return { metricRows, prePeriodRows, activationRows: resolvedActivationRows };
}
