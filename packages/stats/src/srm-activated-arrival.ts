import type { ActivationRow, DedupeExposureRow } from "@splitch/contracts";

/**
 * Earliest Activation timestamp that places the Entity in the activated
 * population (`activation_ts > first_exposure_ts`). That instant is when the
 * Entity enters the activated-SRM filtration.
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
