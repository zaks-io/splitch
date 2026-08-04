import type { EnvironmentPolicy } from "@splitch/contracts";

/**
 * Isolate-local Environment Policy entries used only to prove the gate path
 * never serves a cached value (SPL-292). Production code must not populate this
 * map as a read-through cache for enforcement — the approval gate always reads
 * D1 authoritatively via `readEnvironmentPolicy`.
 *
 * A policy write clears the entry so a future contributor cannot "optimize" the
 * gate by reading this map after an Environment Policy update acks.
 */
const isolatePolicyCache = new Map<string, EnvironmentPolicy>();

function cacheKey(appId: string, environmentId: string): string {
  return `${appId}:${environmentId}`;
}

/** Drop any isolate-local entry after an Environment Policy write commits. */
export function invalidateEnvironmentPolicyGateCache(appId: string, environmentId: string): void {
  isolatePolicyCache.delete(cacheKey(appId, environmentId));
}

/**
 * Test-only: seed a stale policy the gate must not observe. Production handlers
 * never call this.
 */
export function seedStaleEnvironmentPolicyGateCacheForTest(
  appId: string,
  environmentId: string,
  policy: EnvironmentPolicy,
): void {
  isolatePolicyCache.set(cacheKey(appId, environmentId), policy);
}

/** Test-only: inspect whether a seeded entry is still present. */
export function peekEnvironmentPolicyGateCacheForTest(
  appId: string,
  environmentId: string,
): EnvironmentPolicy | undefined {
  return isolatePolicyCache.get(cacheKey(appId, environmentId));
}

/**
 * Called at the start of every gate Policy read. Returns undefined always for
 * enforcement — a seeded entry is dropped so the subsequent D1 read is what
 * the gate evaluates. This is the invalidation half of read-your-writes.
 */
export function takeEnvironmentPolicyGateCacheMiss(
  appId: string,
  environmentId: string,
): undefined {
  invalidateEnvironmentPolicyGateCache(appId, environmentId);
  return undefined;
}
