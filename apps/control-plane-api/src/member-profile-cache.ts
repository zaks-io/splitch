import { MemberProfileCacheSchema, memberProfileCacheKey } from "@splitch/contracts";
import type { MemberProfileResolver } from "./org-handlers";

/**
 * Resolve Org-member email from the shared SESSION_STORE identity cache.
 * Auth-api (device flow / claim) and the Control Panel AuthKit callback write
 * `member-profile:{userId}` at login; this Worker only reads.
 */
export function makeSessionCacheMemberProfileResolver(kv: KVNamespace): MemberProfileResolver {
  return async ({ userId }) => {
    const raw = await kv.get(memberProfileCacheKey(userId));
    if (!raw) return null;

    const profile = MemberProfileCacheSchema.parse(JSON.parse(raw));
    return { email: profile.email };
  };
}
