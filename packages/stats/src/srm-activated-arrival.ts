import type { ActivationRow, DedupeExposureRow } from "@splitch/contracts";

/**
 * Earliest Activation ingestion timestamp among rows that place the Entity in
 * the activated population (`activation_ts > first_exposure_ts`). That ingest
 * instant is when the Entity enters the activated-SRM filtration.
 */
export function earliestValidActivationIngestTs(
  exposure: DedupeExposureRow,
  activationRowsByEntity: ReadonlyMap<string, readonly ActivationRow[]>,
): string {
  const exposureMs = timestampMs(exposure.first_exposure_ts, "first_exposure_ts");
  const rows = activationRowsByEntity.get(exposure.targeting_key_hash) ?? [];
  let earliestIngestTs: string | null = null;
  let earliestIngestMs = Number.POSITIVE_INFINITY;

  for (const row of rows) {
    if (!row.activated) {
      continue;
    }
    const activationMs = timestampMs(row.activation_ts, "activation_ts");
    if (activationMs <= exposureMs) {
      continue;
    }
    const ingestMs = timestampMs(row.activation_ingest_ts, "activation_ingest_ts");
    if (ingestMs < earliestIngestMs) {
      earliestIngestMs = ingestMs;
      earliestIngestTs = row.activation_ingest_ts;
    }
  }

  if (earliestIngestTs === null) {
    throw new Error(
      `activated SRM entity ${exposure.targeting_key_hash} has no post-Exposure activation_ingest_ts.`,
    );
  }
  return earliestIngestTs;
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
