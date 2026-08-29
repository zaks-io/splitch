import { membershipCacheKey } from "@splitch/contracts";

export async function invalidateMembershipCache(
  kv: KVNamespace,
  userIds: readonly string[],
): Promise<void> {
  await Promise.all([...new Set(userIds)].map((userId) => kv.delete(membershipCacheKey(userId))));
}
