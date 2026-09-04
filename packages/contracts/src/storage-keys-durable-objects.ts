/**
 * Durable Object instance names. A DO name is an address, not a key: it decides
 * which single-threaded instance serializes a write, so a caller that derives it
 * differently from the writer silently addresses a different (empty) instance.
 * These live here so the writer and every reader share one definition.
 */

/**
 * One Assignment Store instance per ENTITY (not per entity+experiment): the
 * entity-level KV blob is read-merge-written by the writer, so every write for
 * an entity must pass through the same serialization point. Per-experiment
 * instances racing on the shared blob would clobber each other's first-touch
 * entries.
 *
 * Pairs with `assignmentKey`, which addresses the KV mirror of this same
 * entity. The instance is authoritative and the KV blob lags it.
 */
export function assignmentWriterName(input: {
  appId: string;
  idType: string;
  targetingKeyHash: string;
}): string {
  return `${input.appId}:${input.idType}:${input.targetingKeyHash}`;
}
