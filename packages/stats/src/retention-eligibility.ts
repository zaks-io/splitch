import type { DedupeExposureRow, MetricRetentionHorizon, StatsInput } from "@splitch/contracts";

export function retentionHorizonForMetric(
  input: Pick<StatsInput, "metric_retention_horizons">,
  metricId: string,
): MetricRetentionHorizon {
  const horizons = input.metric_retention_horizons ?? [];
  const match = horizons.filter((horizon) => horizon.metric_id === metricId);
  if (match.length !== 1 || match[0] === undefined) {
    throw new Error(
      `Retention Metric ${metricId} requires exactly one frozen horizon; got ${match.length}`,
    );
  }
  return match[0];
}

export function parseWatermarkMs(dataWatermark: string | undefined, metricId: string): number {
  if (dataWatermark === undefined) {
    throw new Error(
      `Retention Metric ${metricId} requires data_watermark to decide maturity; none was supplied`,
    );
  }
  const parsed = Date.parse(dataWatermark);
  if (!Number.isFinite(parsed)) {
    throw new Error(`data_watermark must be an ISO timestamp; got ${dataWatermark}`);
  }
  return parsed;
}

/**
 * Eligible once anchor + horizon_end <= the analysis watermark. Ineligible
 * Entities must leave this Metric's numerator and denominator; counting them as
 * 0 would treat immature rows as failures.
 */
function isRetentionMature(
  windowAnchor: string,
  horizonEndMs: number,
  watermarkMs: number,
): boolean {
  const anchorMs = Date.parse(windowAnchor);
  if (!Number.isFinite(anchorMs)) {
    throw new Error(`window_anchor must be an ISO timestamp; got ${windowAnchor}`);
  }
  return anchorMs + horizonEndMs <= watermarkMs;
}

export function partitionRetentionExposures(
  exposures: readonly DedupeExposureRow[],
  horizonEndMs: number,
  watermarkMs: number,
): { eligible: DedupeExposureRow[]; immatureExcluded: number } {
  const eligible: DedupeExposureRow[] = [];
  let immatureExcluded = 0;
  for (const exposure of exposures) {
    if (isRetentionMature(exposure.window_anchor, horizonEndMs, watermarkMs)) {
      eligible.push(exposure);
    } else {
      immatureExcluded += 1;
    }
  }
  return { eligible, immatureExcluded };
}
