import { MEMBERSHIP_CACHE_TTL_SECONDS, type MembershipSet } from "@splitch/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  invalidateMembershipCache,
  type MembershipCacheInvalidator,
  makeMembershipCacheInvalidator,
  mutateMembershipWithCacheInvalidation,
} from "./membership-cache";
import { makeTokenMembershipAccess } from "./token-membership";

const USER = "user_membership_cache";
const ORG = "org_membership_cache";
const APP = "app_membership_cache";

const memberships: MembershipSet = {
  organizations: [{ id: ORG, role: "admin" }],
  apps: [{ id: APP, organizationId: ORG, role: "admin" }],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("membership cache reads", () => {
  it("pins absolute D1 query count at zero for authorize and resolve cache hits", async () => {
    const d1 = countingIdentity();
    const access = makeTokenMembershipAccess(d1.repo, cache(JSON.stringify(memberships)));

    await expect(access.authorize(USER, [{ axis: "app", id: APP, role: "admin" }])).resolves.toBe(
      true,
    );
    expect(d1.queryCount()).toBe(0);

    await expect(access.resolve(USER)).resolves.toEqual(memberships);
    expect(d1.queryCount()).toBe(0);
  });

  it("falls through corrupt JSON to the complete live D1 resolve and never allows", async () => {
    const d1 = countingIdentity();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const access = makeTokenMembershipAccess(d1.repo, cache("{not-json"));

    await expect(access.authorize(USER, [{ axis: "app", id: APP, role: "member" }])).resolves.toBe(
      false,
    );
    expect(d1.queryCount()).toBe(2);
    expect(error).toHaveBeenCalledWith(
      "control-plane: invalid membership cache payload; resolving from D1",
      expect.objectContaining({ userId: USER }),
    );
  });

  it("falls through a schema-invalid payload to D1 and never allows", async () => {
    const d1 = countingIdentity();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const invalid = JSON.stringify({
      organizations: [],
      apps: [{ id: APP, organizationId: ORG, role: "admin" }],
    });
    const access = makeTokenMembershipAccess(d1.repo, cache(invalid));

    await expect(access.authorize(USER, [{ axis: "app", id: APP, role: "member" }])).resolves.toBe(
      false,
    );
    expect(d1.queryCount()).toBe(2);
  });

  it("falls through a thrown KV read to the complete live D1 resolve and never allows", async () => {
    const d1 = countingIdentity();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const access = makeTokenMembershipAccess(d1.repo, faultingCache());

    await expect(access.authorize(USER, [{ axis: "org", id: ORG, role: "member" }])).resolves.toBe(
      false,
    );
    expect(d1.queryCount()).toBe(2);
    expect(error).toHaveBeenCalledWith(
      "control-plane: membership cache read failed; resolving from D1",
      expect.objectContaining({ userId: USER }),
    );
  });

  it("does not fill a cold cache when the request can mutate membership", async () => {
    const d1 = countingIdentity();
    let wrote = false;
    const kv = {
      get: async () => null,
      put: async () => {
        wrote = true;
      },
      delete: async () => {
        if (wrote) throw new Error("KV write rate exceeded");
      },
    } as unknown as KVNamespace;
    const access = makeTokenMembershipAccess(d1.repo, kv, false);

    await expect(access.resolve(USER)).resolves.toEqual({ organizations: [], apps: [] });
    await expect(
      invalidateMembershipCache(makeMembershipCacheInvalidator(kv), [USER]),
    ).resolves.toBeUndefined();
    expect(d1.queryCount()).toBe(2);
    expect(wrote).toBe(false);
  });

  it("applies the security TTL to the KV entry written on a cache miss", async () => {
    const puts: Array<{ key: string; options?: KVNamespacePutOptions }> = [];
    const kv = {
      get: async () => null,
      put: async (key: string, _value: string, options?: KVNamespacePutOptions) => {
        puts.push({ key, options });
      },
      delete: async () => undefined,
    } as unknown as KVNamespace;
    const access = makeTokenMembershipAccess(countingIdentity().repo, kv);

    await access.resolve(USER);

    expect(puts).toEqual([
      {
        key: `memberships:${USER}`,
        options: { expirationTtl: MEMBERSHIP_CACHE_TTL_SECONDS },
      },
    ]);
  });

  it("fails at construction when SESSION_STORE is unwired", () => {
    expect(() => makeTokenMembershipAccess(countingIdentity().repo, undefined)).toThrow(
      "control-plane: SESSION_STORE KV binding is required",
    );
    expect(() => makeMembershipCacheInvalidator(undefined)).toThrow(
      "control-plane: SESSION_STORE KV binding is required",
    );
    expect(() => makeTokenMembershipAccess(countingIdentity().repo, {} as KVNamespace)).toThrow(
      "control-plane: SESSION_STORE KV binding is required",
    );
  });
});

describe("membership cache invalidation", () => {
  it("fails loud when the invalidator is unwired", async () => {
    await expect(invalidateMembershipCache(undefined, [USER])).rejects.toThrow(
      "control-plane: membership cache invalidator is required",
    );
  });

  it("propagates a KV delete failure", async () => {
    await expect(
      invalidateMembershipCache(
        {
          invalidate: async () => {
            throw new Error("KV delete failed");
          },
        },
        [USER],
      ),
    ).rejects.toThrow("KV delete failed");
  });

  it("invalidates once after the D1 mutation commits", async () => {
    const events: string[] = [];
    const invalidator: MembershipCacheInvalidator = {
      invalidate: async (userId) => {
        events.push(`delete:${userId}`);
      },
    };

    await mutateMembershipWithCacheInvalidation(invalidator, [USER], async () => {
      events.push("mutation");
    });

    expect(events).toEqual(["mutation", `delete:${USER}`]);
  });

  it("propagates a post-commit invalidation failure", async () => {
    let committed = false;
    await expect(
      mutateMembershipWithCacheInvalidation(
        {
          invalidate: async () => {
            throw new Error("KV delete failed");
          },
        },
        [USER],
        async () => {
          committed = true;
        },
      ),
    ).rejects.toThrow("KV delete failed");
    expect(committed).toBe(true);
  });
});

function countingIdentity() {
  let queries = 0;
  return {
    queryCount: () => queries,
    repo: {
      identity: {
        listOrgMembershipsForUser: async () => {
          queries += 1;
          return [];
        },
        listAppMembershipsWithAppForUser: async () => {
          queries += 1;
          return [];
        },
      },
    } as unknown as Parameters<typeof makeTokenMembershipAccess>[0],
  };
}

function cache(raw: string): KVNamespace {
  return {
    get: async () => raw,
    put: async () => undefined,
    delete: async () => undefined,
  } as unknown as KVNamespace;
}

function faultingCache(): KVNamespace {
  return {
    get: async () => {
      throw new Error("KV unavailable");
    },
    put: async () => undefined,
    delete: async () => undefined,
  } as unknown as KVNamespace;
}
