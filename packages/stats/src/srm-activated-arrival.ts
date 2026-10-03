import type { ActivationRow, DedupeExposureRow } from "@splitch/contracts";

/**
 * Earliest Activation timestamp that places the Entity in the activated
 * population (`activation_ts > first_exposure_ts`). Event time, not ingest
 * time: Metric windows and cohort days anchor here.
 */
export function earliestValidActivationTs(
  exposure: DedupeExposureRow,
  activationRowsByEntity: ReadonlyMap<string, readonly ActivationRow[]>,
): string {
  const exposureMs = timestampMs(exposure.first_exposure_ts, "first_exposure_ts");
  const rows = activationRowsByEntity.get(exposure.targeting_key_hash) ?? [];
  let earliestTs: string | null = null;
  let earliestMs = Number.POSITIVE_INFINITY;

  for (const row of rows) {
    if (!row.activated) {
      continue;
    }
    const activationMs = timestampMs(row.activation_ts, "activation_ts");
    if (activationMs > exposureMs && activationMs < earliestMs) {
      earliestMs = activationMs;
      earliestTs = row.activation_ts;
    }
  }

  if (earliestTs === null) {
    throw new Error(
      `activated SRM entity ${exposure.targeting_key_hash} has no post-Exposure activation_ts.`,
    );
  }
  return earliestTs;
}

/**
 * When the Entity became eligible for activated-population SRM: the minimum
 * over qualifying raw (Exposure, Activation) pairs with
 * `exposure_at < activation_ts` of `max(exposure.ingest_ts, activation.ingest_ts)`.
 *
 * Using `max(first_ingest_ts, activation_ingest)` on the deduped Exposure would
 * back-date when a late earlier Exposure makes a previously non-qualifying
 * Activation valid (the early Exposure ingest is not part of any qualifying
 * pair until that late row arrives).
 */
export function earliestValidActivationIngestTs(
  exposures: readonly DedupeExposureRow[],
  activationRows: readonly ActivationRow[],
): string {
  const earliestEligibilityTs = minQualifyingPairEligibilityTs(exposures, activationRows);
  if (earliestEligibilityTs === null) {
    const entity = exposures[0]?.targeting_key_hash ?? "unknown";
    throw new Error(
      `activated SRM entity ${entity} has no qualifying Exposure/Activation ingest pair.`,
    );
  }
  return earliestEligibilityTs;
}

function minQualifyingPairEligibilityTs(
  exposures: readonly DedupeExposureRow[],
  activationRows: readonly ActivationRow[],
): string | null {
  let earliestEligibilityTs: string | null = null;
  let earliestEligibilityMs = Number.POSITIVE_INFINITY;
  for (const exposure of exposures) {
    for (const row of activationRows) {
      const pairTs = qualifyingPairEligibilityTs(exposure, row);
      if (pairTs === null) {
        continue;
      }
      const pairMs = timestampMs(pairTs, "eligibility_ingest_ts");
      if (pairMs >= earliestEligibilityMs) {
        continue;
      }
      earliestEligibilityMs = pairMs;
      earliestEligibilityTs = pairTs;
    }
  }
  return earliestEligibilityTs;
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

/** Group Exposure rows for one Run by Entity (keeps raw-like duplicates). */
export function exposuresByEntityForRun(
  runId: string,
  exposures: readonly DedupeExposureRow[],
): Map<string, DedupeExposureRow[]> {
  const byEntity = new Map<string, DedupeExposureRow[]>();
  for (const exposure of exposures) {
    if (exposure.run_id !== runId) {
      continue;
    }
    const existing = byEntity.get(exposure.targeting_key_hash);
    if (existing === undefined) {
      byEntity.set(exposure.targeting_key_hash, [exposure]);
    } else {
      existing.push(exposure);
    }
  }
  return byEntity;
}

function qualifyingPairEligibilityTs(
  exposure: DedupeExposureRow,
  row: ActivationRow,
): string | null {
  if (!row.activated) {
    return null;
  }
  const exposureEventMs = timestampMs(exposure.first_exposure_ts, "first_exposure_ts");
  const activationMs = timestampMs(row.activation_ts, "activation_ts");
  if (!(exposureEventMs < activationMs)) {
    return null;
  }
  const exposureIngestTs = requiredTimestamp(exposure.first_ingest_ts, "first_ingest_ts");
  const activationIngestTs = requiredTimestamp(row.activation_ingest_ts, "activation_ingest_ts");
  const exposureIngestMs = timestampMs(exposureIngestTs, "first_ingest_ts");
  const activationIngestMs = timestampMs(activationIngestTs, "activation_ingest_ts");
  return exposureIngestMs >= activationIngestMs ? exposureIngestTs : activationIngestTs;
}

function requiredTimestamp(value: string | null | undefined, field: string): string {
  if (value === undefined || value === null || value === "") {
    throw new Error(`${field} is required for analysis-v2 SRM eligibility.`);
  }
  return value;
}

function timestampMs(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be an ISO timestamp.`);
  }
  return parsed;
}
