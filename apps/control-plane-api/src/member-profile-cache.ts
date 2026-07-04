import type { MemberProfileResolver } from "./org-handlers";

const MEMBER_PROFILE_PREFIX = "member-profile:";

interface CachedMemberProfile {
  email: string;
}

export function memberProfileCacheKey(userId: string): string {
  return `${MEMBER_PROFILE_PREFIX}${userId}`;
}

export function makeSessionCacheMemberProfileResolver(kv: KVNamespace): MemberProfileResolver {
  return async ({ userId }) => {
    const raw = await kv.get(memberProfileCacheKey(userId));
    if (!raw) return null;

    const profile = parseCachedMemberProfile(raw);
    return { email: profile.email };
  };
}

function parseCachedMemberProfile(raw: string): CachedMemberProfile {
  const value = JSON.parse(raw) as unknown;
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as CachedMemberProfile).email !== "string" ||
    (value as CachedMemberProfile).email.length === 0
  ) {
    throw new Error("member profile cache entry is invalid");
  }
  return value as CachedMemberProfile;
}
