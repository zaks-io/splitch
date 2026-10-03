/**
 * One Entity in the current watermarked population, already filtered to a real
 * arm (not `__multiple__`). The sequential SRM gate rebuilds its look path from
 * these rows on every Results read.
 *
 * `arrival_ts` is the eligibility clock: `first_ingest_ts` for Exposure SRM and
 * pairwise `min(max(exposure.ingest, activation.ingest))` for activated SRM.
 * Event time (`first_exposure_ts` / `activation_ts`) is not the filtration order.
 */
export interface SrmPathEntity {
  readonly targeting_key_hash: string;
  readonly variant: string;
  readonly arrival_ts: string;
}

/**
 * Deterministic total order for the analysis-v2 SRM filtration: ascending
 * ingestion time, then Entity pseudonym. Ties must break the same way on every
 * pinned-watermark read so the result token stays reproducible. Ordering by
 * ingestion keeps a later watermark's path an extension of an earlier one.
 */
export function compareSrmPathEntities(left: SrmPathEntity, right: SrmPathEntity): number {
  const leftMs = arrivalMs(left.arrival_ts);
  const rightMs = arrivalMs(right.arrival_ts);
  if (leftMs !== rightMs) {
    return leftMs - rightMs;
  }
  if (left.targeting_key_hash < right.targeting_key_hash) {
    return -1;
  }
  if (left.targeting_key_hash > right.targeting_key_hash) {
    return 1;
  }
  if (left.variant !== right.variant) {
    throw new Error(
      `SRM observation path saw conflicting variants for ${left.targeting_key_hash}.`,
    );
  }
  return 0;
}

/**
 * Sort Entities into the append-only ingestion filtration. Mutates `entities`
 * in place so callers that already own the array avoid a second allocation.
 * Every timestamp is validated before sorting so a singleton malformed Entity
 * fails loud instead of skipping the comparator.
 */
export function sortEntitiesByArrival(entities: SrmPathEntity[]): SrmPathEntity[] {
  for (const entity of entities) {
    arrivalMs(entity.arrival_ts);
  }
  entities.sort(compareSrmPathEntities);
  return entities;
}

function arrivalMs(arrivalTs: string): number {
  const parsed = Date.parse(arrivalTs);
  if (!Number.isFinite(parsed)) {
    throw new Error(`arrival_ts must be an ISO timestamp; got ${arrivalTs}`);
  }
  return parsed;
}
