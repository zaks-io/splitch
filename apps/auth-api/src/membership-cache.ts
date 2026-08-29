import { membershipCacheKey } from "@splitch/contracts";

async function invalidateMembershipCache(
  kv: KVNamespace,
  userIds: readonly string[],
): Promise<void> {
  await Promise.all([...new Set(userIds)].map((userId) => kv.delete(membershipCacheKey(userId))));
}

export async function mutateMembershipWithCacheInvalidation<T>(
  kv: KVNamespace,
  userIds: readonly string[],
  mutate: () => Promise<T>,
): Promise<T> {
  const result = await mutate();
  // Invalidate once after D1 commits: Workers KV permits only one write per key
  // per second. A concurrent reader can still refill a pre-commit value, but
  // every tenant-scoped route now rechecks membership in live D1, so that race
  // is a bounded-latency concern rather than an authorization decision.
  await invalidateMembershipCache(kv, userIds);
  return result;
}
