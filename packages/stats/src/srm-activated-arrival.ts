import type { ActivationRow, DedupeExposureRow } from "@splitch/contracts";

/**
 * When the Entity became eligible for activated-population SRM: the later of
 * first Exposure ingest and the earliest valid post-Exposure Activation ingest.
 * Using Activation ingest alone would place an Entity that activated before its
 * Exposure into an earlier path prefix once the late Exposure arrives.
 */
export function earliestValidActivationIngestTs(
  exposure: DedupeExposureRow,
  activationRowsByEntity: ReadonlyMap<string, readonly ActivationRow[]>,
): string {
  const exposureEventMs = timestampMs(exposure.first_exposure_ts, "first_exposure_ts");
  const exposureIngestMs = timestampMs(exposure.first_ingest_ts, "first_ingest_ts");
  const rows = activationRowsByEntity.get(exposure.targeting_key_hash) ?? [];
  let earliestActivationIngestTs: string | null = null;
  let earliestActivationIngestMs = Number.POSITIVE_INFINITY;

  for (const row of rows) {
    if (!row.activated) {
      continue;
    }
    const activationMs = timestampMs(row.activation_ts, "activation_ts");
    if (activationMs <= exposureEventMs) {
      continue;
    }
    const ingestMs = timestampMs(row.activation_ingest_ts, "activation_ingest_ts");
    if (ingestMs < earliestActivationIngestMs) {
      earliestActivationIngestMs = ingestMs;
      earliestActivationIngestTs = row.activation_ingest_ts;
    }
  }

  if (earliestActivationIngestTs === null) {
    throw new Error(
      `activated SRM entity ${exposure.targeting_key_hash} has no post-Exposure activation_ingest_ts.`,
    );
  }

  if (exposureIngestMs > earliestActivationIngestMs) {
    return exposure.first_ingest_ts;
  }
  return earliestActivationIngestTs;
}

/** Index activated rows for one Run; skips other Runs and inactive rows. */
export function activationRowsByEntityForRun(
  runId: string,
  rows: readonly ActivationRow[],
): Map<string, ActivationRow[]> {
  const byEntity = new Map<string, ActivationRow[]>();
  for (const row of rows) {
    if (row.run_id !== runId || !row.activated) {
      continue;
    }
    const existing = byEntity.get(row.targeting_key_hash);
    if (existing === undefined) {
      byEntity.set(row.targeting_key_hash, [row]);
    } else {
      existing.push(row);
    }
  }
  return byEntity;
}

function timestampMs(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be an ISO timestamp.`);
  }
  return parsed;
}
