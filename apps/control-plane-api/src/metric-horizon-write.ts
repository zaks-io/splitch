import type { MetricKind } from "@splitch/contracts";
import type { MetricRow } from "./metric-segment-shared";
import type { PreparedMetricWrite } from "./metric-write";

type MetricPatch = {
  horizonStartMs?: number | null;
  horizonEndMs?: number | null;
};

export function metricHorizons(
  body: Record<string, unknown>,
  kind: MetricKind,
  current: MetricRow | null,
): { horizonStartMs: number | null; horizonEndMs: number | null } {
  if (kind !== "retention") {
    return { horizonStartMs: null, horizonEndMs: null };
  }
  return {
    horizonStartMs: resolveHorizon(body, "horizonStartMs", current),
    horizonEndMs: resolveHorizon(body, "horizonEndMs", current),
  };
}

export function copyHorizons(
  body: Record<string, unknown>,
  patch: MetricPatch,
  prepared: PreparedMetricWrite,
): void {
  if (body.horizonStartMs !== undefined) patch.horizonStartMs = prepared.horizonStartMs;
  if (body.horizonEndMs !== undefined) patch.horizonEndMs = prepared.horizonEndMs;
}

function resolveHorizon(
  body: Record<string, unknown>,
  field: "horizonStartMs" | "horizonEndMs",
  current: MetricRow | null,
): number | null {
  if (body[field] !== undefined) return body[field] as number | null;
  return current?.[field] ?? null;
}
