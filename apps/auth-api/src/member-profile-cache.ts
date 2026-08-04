import { memberProfileCacheKey, MemberProfileCacheSchema } from "@splitch/contracts";

/**
 * Persist the authenticated User's email in the shared SESSION_STORE identity
 * cache so control-plane Org member endpoints can resolve profiles without a
 * D1 PII column (organization-and-membership.md). Auth-api and control-plane
 * share the same KV namespace IDs.
 */
export async function rememberMemberProfile(
  kv: KVNamespace,
  userId: string,
  email: string,
): Promise<void> {
  const profile = MemberProfileCacheSchema.parse({ email });
  await kv.put(memberProfileCacheKey(userId), JSON.stringify(profile));
}
