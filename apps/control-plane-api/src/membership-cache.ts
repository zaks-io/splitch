import {
  MEMBERSHIP_CACHE_TTL_SECONDS,
  type MembershipSet,
  MembershipSetSchema,
  membershipCacheKey,
} from "@splitch/contracts";

type MembershipCacheLogger = Pick<Console, "error" | "info">;

export interface MembershipCacheInvalidator {
  invalidate(userId: string): Promise<void>;
}

export function makeMembershipCacheInvalidator(kv: KVNamespace): MembershipCacheInvalidator {
  return {
    invalidate(userId) {
      return kv.delete(membershipCacheKey(userId));
    },
  };
}

export async function invalidateMembershipCache(
  invalidator: MembershipCacheInvalidator | undefined,
  userIds: readonly string[],
): Promise<void> {
  if (!invalidator) {
    throw new Error("control-plane: membership cache invalidator is required");
  }
  await Promise.all([...new Set(userIds)].map((userId) => invalidator.invalidate(userId)));
}

export async function resolveCachedMemberships(
  kv: KVNamespace,
  userId: string,
  load: () => Promise<MembershipSet>,
  logger: MembershipCacheLogger = console,
  writeOnMiss = true,
): Promise<MembershipSet> {
  const cached = await readMembershipCache(kv, userId, logger);
  if (cached) return cached;

  const memberships = MembershipSetSchema.parse(await load());
  if (!writeOnMiss) return memberships;
  try {
    await kv.put(membershipCacheKey(userId), JSON.stringify(memberships), {
      expirationTtl: MEMBERSHIP_CACHE_TTL_SECONDS,
    });
  } catch (cause) {
    logger.error("control-plane: membership cache fill failed", { userId, cause });
  }
  return memberships;
}

async function readMembershipCache(
  kv: KVNamespace,
  userId: string,
  logger: MembershipCacheLogger,
): Promise<MembershipSet | null> {
  let raw: string | null;
  try {
    raw = await kv.get(membershipCacheKey(userId), "text");
  } catch (cause) {
    logger.error("control-plane: membership cache read failed; resolving from D1", {
      userId,
      cause,
    });
    return null;
  }
  if (raw === null) {
    logger.info("control-plane: membership cache miss; resolving from D1", { userId });
    return null;
  }
  try {
    return MembershipSetSchema.parse(JSON.parse(raw));
  } catch (cause) {
    logger.error("control-plane: invalid membership cache payload; resolving from D1", {
      userId,
      cause,
    });
    return null;
  }
}
