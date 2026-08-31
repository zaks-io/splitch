import { appScope } from "@splitch/db";
import { describe, expect, it, vi } from "vitest";
import {
  authorizeBearerMembership,
  makeTokenMembershipAccess,
  requireTokenMembershipAccess,
  resolveMcpMembershipScopes,
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
    );
    await expect(access.authorize(USER, [{ axis: "app", id: APP, role: "admin" }])).resolves.toBe(
      false,
    );
  });

  it("rejects a missing Org claim", async () => {
    const access = makeTokenMembershipAccess(identity({ orgRole: null }));
    await expect(access.authorize(USER, [{ axis: "org", id: ORG, role: "admin" }])).resolves.toBe(
      false,
    );
  });

  it("accepts an Org claim when live role still covers the minted role", async () => {
    const access = makeTokenMembershipAccess(identity({ orgRole: "owner" }));
    await expect(access.authorize(USER, [{ axis: "org", id: ORG, role: "admin" }])).resolves.toBe(
      true,
    );
  });

  it("looks up App membership through the tenant scope, never a bare app id", async () => {
    const getAppMembership = vi.fn(async () => ({ role: "member" }));
    const access = makeTokenMembershipAccess(
      identity({
        getAppMembership,
        orgForApp: { role: "member" },
      }),
    );
    await access.authorize(USER, [{ axis: "app", id: APP, role: "member" }]);
    expect(getAppMembership).toHaveBeenCalledWith(appScope(APP), USER);
  });

  it("resolves the complete live membership set for the User", async () => {
    const access = makeTokenMembershipAccess({
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
    } as unknown as Parameters<typeof makeTokenMembershipAccess>[0]);

    await expect(access.resolve(USER)).resolves.toEqual({
      organizations: [
        { id: ORG, role: "admin" },
        { id: "org_other", role: "member" },
      ],
      apps: [{ id: APP, organizationId: ORG, role: "owner" }],
    });
  });
});

describe("resolveMcpMembershipScopes", () => {
  it("converts the complete live membership set to canonical delegation scopes", async () => {
    const resolve = vi.fn(async () => ({
      organizations: [{ id: ORG, role: "admin" as const }],
      apps: [{ id: APP, organizationId: ORG, role: "owner" as const }],
    }));

    await expect(resolveMcpMembershipScopes(fakeAccess({ resolve }), USER)).resolves.toEqual([
      `app:${APP}:owner`,
      `org:${ORG}:admin`,
    ]);
    expect(resolve).toHaveBeenCalledWith(USER);
  });

  it.each([
    "",
    "x".repeat(257),
  ])("rejects invalid user id %j before membership lookup", async (userId) => {
    const resolve = vi.fn();
    await expect(resolveMcpMembershipScopes(fakeAccess({ resolve }), userId)).rejects.toThrow(
      "control-plane-api: invalid MCP user id",
    );
    expect(resolve).not.toHaveBeenCalled();
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
  getAppMembership?: (
    scope: ReturnType<typeof appScope>,
    userId: string,
  ) => Promise<{ role: string } | null>;
}) {
  return {
    identity: {
      getOrgMembership: async () =>
        options.orgRole === undefined || options.orgRole === null
          ? null
          : { role: options.orgRole },
      getOrgMembershipForApp: async () => options.orgForApp ?? null,
      getAppMembership:
        options.getAppMembership ??
        (async () => (options.appRole ? { role: options.appRole } : null)),
    },
  };
}
