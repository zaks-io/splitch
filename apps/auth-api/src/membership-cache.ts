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
  await invalidateMembershipCache(kv, userIds);
  const result = await mutate();
  await invalidateMembershipCache(kv, userIds);
  return result;
}
