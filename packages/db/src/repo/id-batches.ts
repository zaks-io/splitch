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
const D1_TWO_AXIS_BATCH_SIZE = D1_ID_BATCH_SIZE / 2;

/** Splits an id set into batches D1 will accept as `IN (...)` parameters. */
export function idBatches<T>(ids: readonly T[]): T[][] {
  return batchesOf(ids, D1_ID_BATCH_SIZE);
}

/**
 * Cartesian batches for a statement with two independent `IN (...)` axes.
 *
 * Each side contributes at most 45 bindings, leaving the same deliberate D1
 * headroom as `idBatches` for app_id and fixed predicates such as status.
 */
export function twoAxisIdBatches<A, B>(
  firstIds: readonly A[],
  secondIds: readonly B[],
): Array<{ first: A[]; second: B[] }> {
  if (firstIds.length === 0 || secondIds.length === 0) return [];
  return batchesOf(firstIds, D1_TWO_AXIS_BATCH_SIZE).flatMap((first) =>
    batchesOf(secondIds, D1_TWO_AXIS_BATCH_SIZE).map((second) => ({ first, second })),
  );
}

function batchesOf<T>(ids: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < ids.length; start += size) {
    batches.push(ids.slice(start, start + size));
  }
  return batches;
}
