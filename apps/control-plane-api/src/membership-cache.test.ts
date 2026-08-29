import type { MembershipSet } from "@splitch/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invalidateMembershipCache, makeMembershipCacheInvalidator } from "./membership-cache";
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
});

describe("membership cache invalidation", () => {
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
  } as unknown as KVNamespace;
}

function faultingCache(): KVNamespace {
  return {
    get: async () => {
      throw new Error("KV unavailable");
    },
    put: async () => undefined,
  } as unknown as KVNamespace;
}
