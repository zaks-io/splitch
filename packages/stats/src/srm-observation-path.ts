/**
 * One Entity in the current watermarked population, already filtered to a real
 * arm (not `__multiple__`). The sequential SRM gate rebuilds its look path from
 * these rows on every Results read.
 *
 * `arrival_ts` is first Exposure for Exposure SRM and the Entity's earliest
 * valid Activation timestamp for activated-population SRM.
 */
export interface SrmPathEntity {
  readonly targeting_key_hash: string;
  readonly variant: string;
  readonly arrival_ts: string;
}

/**
 * Deterministic total order for the analysis-v2 SRM filtration: ascending
 * arrival time, then Entity pseudonym. Ties must break the same way on every
 * pinned-watermark read so the result token stays reproducible.
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
 * Sort Entities into the append-only arrival filtration. Mutates `entities` in
 * place so callers that already own the array avoid a second allocation.
 */
export function sortEntitiesByArrival(entities: SrmPathEntity[]): SrmPathEntity[] {
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
