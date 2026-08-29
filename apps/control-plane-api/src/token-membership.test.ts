import { describe, expect, it, vi } from "vitest";
import {
  authorizeBearerMembership,
  authorizeResolvedBearerMembership,
  makeTokenMembershipAccess,
  requireTokenMembershipAccess,
  withBearerMembershipCheck,
} from "./token-membership";

const USER = "user_membership_recheck";
const ORG = "org_membership_recheck";
const APP = "app_membership_recheck";

describe("authorizeBearerMembership", () => {
  it("skips tokens whose authority does not derive from membership", async () => {
    const authorize = vi.fn();
    const refused = await authorizeBearerMembership(fakeAccess({ authorize }), USER, [
      "service:smoke",
    ]);
    expect(refused).toBeNull();
    expect(authorize).not.toHaveBeenCalled();
  });

  it("skips the read when no membership axes are present", async () => {
    const authorize = vi.fn();
    await expect(
      authorizeBearerMembership(fakeAccess({ authorize }), USER, []),
    ).resolves.toBeNull();
    expect(authorize).not.toHaveBeenCalled();
  });

  it("throws when the membership port is missing", () => {
    expect(() => requireTokenMembershipAccess(undefined)).toThrow(
      "control-plane: membershipAccess is required",
    );
  });

  it("propagates a thrown membership read instead of minting a principal", async () => {
    await expect(
      authorizeBearerMembership(
        fakeAccess({
          authorize: async () => {
            throw new Error("d1 membership read failed");
          },
        }),
        USER,
        [`app:${APP}:admin`],
      ),
    ).rejects.toThrow("d1 membership read failed");
  });

  it("refuses a claimed membership the port rejects", async () => {
    const refused = await authorizeBearerMembership(
      fakeAccess({ authorize: async () => false }),
      USER,
      [`app:${APP}:admin`],
    );
    expect(refused).toEqual({
      ok: false,
      reason: "UNAUTHORIZED",
      error: {
        code: "FORBIDDEN",
        message: "live membership is required",
        details: {},
      },
    });
  });

  it("passes a claimed membership the port accepts", async () => {
    await expect(
      authorizeBearerMembership(fakeAccess(), USER, [`org:${ORG}:member`]),
    ).resolves.toBeNull();
  });
});

describe("authorizeResolvedBearerMembership", () => {
  it("refuses a surviving App row when its Organization membership is absent", () => {
    expect(
      authorizeResolvedBearerMembership(
        {
          organizations: [],
          apps: [{ id: APP, organizationId: ORG, role: "admin" }],
        },
        [`app:${APP}:admin`],
      ),
    ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });
});

describe("withBearerMembershipCheck", () => {
  it("leaves an already-refused resolver result alone", async () => {
    const authorize = vi.fn(async () => false);
    const wrapped = withBearerMembershipCheck(
      async () => ({ ok: false, reason: "UNAUTHORIZED" }),
      fakeAccess({ authorize }),
    );
    await expect(wrapped(new Request("https://cp.test"))).resolves.toEqual({
      ok: false,
      reason: "UNAUTHORIZED",
    });
    expect(authorize).not.toHaveBeenCalled();
  });

  it("refuses a copied App scope after the inner resolver accepted it", async () => {
    const wrapped = withBearerMembershipCheck(
      async () => ({
        ok: true,
        principal: {
          kind: "control-plane-token",
          id: USER,
          scopes: [`app:${APP}:admin`],
          orgId: null,
          appId: APP,
          environmentId: null,
          authDoor: "id_jag",
        },
      }),
      fakeAccess({ authorize: async () => false }),
    );
    await expect(wrapped(new Request("https://cp.test"))).resolves.toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN", message: "live membership is required" },
    });
  });
});

describe("makeTokenMembershipAccess", () => {
  it("accepts an App claim only when both App and owning-Org memberships hold", async () => {
    const access = makeTokenMembershipAccess(
      identity({
        appRole: "admin",
        orgForApp: { role: "member" },
      }),
      emptyCache(),
    );
    await expect(access.authorize(USER, [{ axis: "app", id: APP, role: "admin" }])).resolves.toBe(
      true,
    );
  });

  it("rejects an App claim after Org removal even if the App row remains", async () => {
    const access = makeTokenMembershipAccess(
      identity({
        appRole: "admin",
        orgForApp: null,
      }),
      emptyCache(),
    );
    await expect(access.authorize(USER, [{ axis: "app", id: APP, role: "admin" }])).resolves.toBe(
      false,
    );
  });

  it("rejects a role-incompatible App claim", async () => {
    const access = makeTokenMembershipAccess(
      identity({
        appRole: "member",
        orgForApp: { role: "member" },
      }),
      emptyCache(),
    );
    await expect(access.authorize(USER, [{ axis: "app", id: APP, role: "admin" }])).resolves.toBe(
      false,
    );
  });

  it("rejects a missing Org claim", async () => {
    const access = makeTokenMembershipAccess(identity({ orgRole: null }), emptyCache());
    await expect(access.authorize(USER, [{ axis: "org", id: ORG, role: "admin" }])).resolves.toBe(
      false,
    );
  });

  it("accepts an Org claim when live role still covers the minted role", async () => {
    const access = makeTokenMembershipAccess(identity({ orgRole: "owner" }), emptyCache());
    await expect(access.authorize(USER, [{ axis: "org", id: ORG, role: "admin" }])).resolves.toBe(
      true,
    );
  });

  it("resolves App memberships only through the user's live Organization ids", async () => {
    const listAppMembershipsWithAppForUser = vi.fn(async () => [
      { role: "member", app: { id: APP, organizationId: ORG } },
    ]);
    const access = makeTokenMembershipAccess(
      identity({
        listAppMembershipsWithAppForUser,
        orgForApp: { role: "member" },
      }),
      emptyCache(),
    );
    await access.authorize(USER, [{ axis: "app", id: APP, role: "member" }]);
    expect(listAppMembershipsWithAppForUser).toHaveBeenCalledWith(USER, [ORG]);
  });

  it("resolves the complete live membership set for the User", async () => {
    const access = makeTokenMembershipAccess(
      {
        identity: {
          listOrgMembershipsForUser: async () => [
            { orgId: ORG, role: "admin" },
            { orgId: "org_other", role: "member" },
          ],
          listAppMembershipsWithAppForUser: async (_userId, orgIds) => {
            expect(orgIds).toEqual([ORG, "org_other"]);
            return [
              {
                role: "owner",
                app: { id: APP, organizationId: ORG },
              },
            ];
          },
        },
      } as unknown as Parameters<typeof makeTokenMembershipAccess>[0],
      emptyCache(),
    );

    await expect(access.resolve(USER)).resolves.toEqual({
      organizations: [
        { id: ORG, role: "admin" },
        { id: "org_other", role: "member" },
      ],
      apps: [{ id: APP, organizationId: ORG, role: "owner" }],
    });
  });
});

function fakeAccess(
  overrides: Partial<Parameters<typeof authorizeBearerMembership>[0]> = {},
): Parameters<typeof authorizeBearerMembership>[0] {
  return {
    authorize: async () => true,
    resolve: async () => ({ organizations: [], apps: [] }),
    ...overrides,
  };
}

function identity(options: {
  appRole?: string | null;
  orgRole?: string | null;
  orgForApp?: { role: string } | null;
  listAppMembershipsWithAppForUser?: (
    userId: string,
    orgIds: readonly string[],
  ) => Promise<{ role: string; app: { id: string; organizationId: string } }[]>;
}) {
  return {
    identity: {
      listOrgMembershipsForUser: async () => {
        if (options.orgRole) return [{ orgId: ORG, role: options.orgRole }];
        if (options.orgForApp) return [{ orgId: ORG, role: options.orgForApp.role }];
        return [];
      },
      listAppMembershipsWithAppForUser:
        options.listAppMembershipsWithAppForUser ??
        (async (_userId: string, orgIds: readonly string[]) =>
          options.appRole && orgIds.includes(ORG)
            ? [{ role: options.appRole, app: { id: APP, organizationId: ORG } }]
            : []),
    },
  } as unknown as Parameters<typeof makeTokenMembershipAccess>[0];
}

function emptyCache(): KVNamespace {
  return {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
  } as unknown as KVNamespace;
}
