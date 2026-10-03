import type { MetricQueryConfig, StatsInput } from "@splitch/contracts";

export function retentionHorizonsFromQueryConfig(
  configs: readonly MetricQueryConfig[],
): NonNullable<StatsInput["metric_retention_horizons"]> {
  return configs.flatMap((config) =>
    config.metric_type === "retention"
      ? [
          {
            metric_id: config.metric_id,
            horizon_start_ms: config.horizon_start_ms,
            horizon_end_ms: config.horizon_end_ms,
          },
        ]
      : [],
  );
}

export function retentionStatsInputFields(
  configs: readonly MetricQueryConfig[],
  dataWatermark: string | undefined,
): Pick<StatsInput, "metric_retention_horizons" | "data_watermark"> {
  const horizons = retentionHorizonsFromQueryConfig(configs);
  return {
    ...(horizons.length > 0 ? { metric_retention_horizons: horizons } : {}),
    ...(dataWatermark !== undefined ? { data_watermark: dataWatermark } : {}),
  };
}
