/**
 * D1 refuses a statement carrying more than 100 bound parameters
 * ("D1_ERROR: too many SQL variables"), so every `IN (...)` over a
 * caller-supplied id set has a hard ceiling with nothing to do with tenancy or
 * with the caller's own read bound.
 *
 * That makes an unbatched `inArray` a landmine rather than a bug: it works right
 * up until some read limit upstream is raised past 100, and then it is a 500 on
 * exactly the largest tenant. Batching removes the coupling instead of documenting
 * it, and the read stays a fixed handful of queries rather than one per row.
 *
 * 90 and not 100 because the same statement also binds the tenant scope columns.
 * The margin is deliberate slack, not a computed maximum: recomputing the true
 * headroom at each call site would put the D1 limit in several places at once.
 */
const D1_ID_BATCH_SIZE = 90;

/** Splits an id set into batches D1 will accept as `IN (...)` parameters. */
export function idBatches<T>(ids: readonly T[]): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < ids.length; start += D1_ID_BATCH_SIZE) {
    batches.push(ids.slice(start, start + D1_ID_BATCH_SIZE));
  }
  return batches;
}
