import { describe, expect, it } from "vitest";
import type { DeviceFlowPort } from "./device-flow";
import type { DeviceRefreshSession } from "./device-session-store";
import type { MembershipAuthorityRepo } from "./membership-authority";
import { form, routeApp, tokenSigner } from "./oauth-route-test-harness";

/**
 * Anyone may add a user to their own Organization, and App keys are unique
 * per Org only. These fixtures give the attacker Org the earlier enumeration
 * position on purpose: a selector rule that resolved by row order, or that
 * matched keys before canonical IDs, would hand the attacker the victim's
 * binding. Each tenant uses distinct identifiers so a passing test cannot be
 * an artifact of shared seeds.
 */
const attackerFirstRepo = {
  identity: {
    listOrgMembershipsForUser: async () => [
      { orgId: "org_attacker", role: "owner" },
      { orgId: "org_victim", role: "member" },
    ],
    listAppsForOrg: async (orgId: string) =>
      orgId === "org_attacker"
        ? [{ id: "app_attackerbait", key: "app_victimtarget" }]
        : [{ id: "app_victimtarget", key: "checkout" }],
    getAppMembership: async () => ({ role: "member" }),
    getOrg: async (orgId: string) => ({ id: orgId, slug: orgId.replace("org_", "") }),
  },
} as unknown as MembershipAuthorityRepo;

/** Both Orgs hold an App keyed `checkout`; neither may win by position. */
const duplicateKeyRepo = {
  identity: {
    listOrgMembershipsForUser: async () => [
      { orgId: "org_one", role: "owner" },
      { orgId: "org_two", role: "owner" },
    ],
    listAppsForOrg: async (orgId: string) =>
      orgId === "org_one"
        ? [{ id: "app_oneside", key: "checkout" }]
        : [{ id: "app_twoside", key: "checkout" }],
    getAppMembership: async () => ({ role: "member" }),
    getOrg: async (orgId: string) => ({ id: orgId, slug: orgId }),
  },
} as unknown as MembershipAuthorityRepo;

function storedSession(overrides: Partial<DeviceRefreshSession> = {}): DeviceRefreshSession {
  return {
    providerSessionId: "session_isolated",
    userId: "user_device",
    providerOrganizationId: null,
    selectedAppSelector: null,
    ...overrides,
  };
}

function isolationApp(params: {
  repo: MembershipAuthorityRepo;
  onProviderRefresh?: () => void;
  minted: string[][];
  organizationId?: string;
}) {
  const deviceFlow = {
    authorizeDevice: async () => {
      throw new Error("not used");
    },
    exchangeDeviceCode: async () => {
      throw new Error("not used");
    },
    refreshProviderToken: async () => {
      params.onProviderRefresh?.();
      return {
        userId: "user_device",
        email: "device@splitch.test",
        organizationId: params.organizationId,
        refreshToken: "refresh_rotated",
        providerSessionId: "session_isolated",
      };
    },
    revokeProviderToken: async () => {
      throw new Error("not used");
    },
  } satisfies DeviceFlowPort;

  return routeApp({
    tokenSigner: {
      ...tokenSigner,
      mintAccessToken: async (_userId, scopes) => {
        params.minted.push([...scopes]);
        return "isolated-access-token";
      },
    },
    repo: params.repo,
    deviceFlow,
    deviceRefreshSessions: {
      remember: async () => {},
      lookup: async () => storedSession({ providerOrganizationId: params.organizationId ?? null }),
      rotate: async () => {},
      forget: async () => {},
    },
  });
}

function refreshRequest(app: ReturnType<typeof routeApp>, extra: Record<string, string> = {}) {
  return app.request("/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({
      grant_type: "refresh_token",
      refresh_token: "refresh_original",
      client_id: "splitch-cli",
      ...extra,
    }),
  });
}

describe("refresh rebind tenant isolation", () => {
  it("resolves a canonical App ID even when another Org keys an App with that ID", async () => {
    const minted: string[][] = [];
    const app = isolationApp({ repo: attackerFirstRepo, minted });

    const res = await refreshRequest(app, { app: "app_victimtarget" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ app_id: "app_victimtarget" });
    expect(minted).toEqual([["app:app_victimtarget:member"]]);
  });

  it("refuses a key that names an App in more than one Organization", async () => {
    const minted: string[][] = [];
    const app = isolationApp({ repo: duplicateKeyRepo, minted });

    const res = await refreshRequest(app, { app: "checkout" });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("invalid_grant");
    expect(body.error_description).toContain("canonical App ID");
    expect(minted).toEqual([]);
  });

  it("does not consume the single-use provider token when the rebind cannot resolve", async () => {
    const minted: string[][] = [];
    let providerRefreshes = 0;
    const app = isolationApp({
      repo: duplicateKeyRepo,
      minted,
      onProviderRefresh: () => {
        providerRefreshes += 1;
      },
    });

    const res = await refreshRequest(app, { app: "no-such-app" });

    expect(res.status).toBe(400);
    // WorkOS refresh tokens are single-use: reaching the provider before the
    // binding resolves would burn the session over a typo'd selector.
    expect(providerRefreshes).toBe(0);
    expect(minted).toEqual([]);
  });

  it("rejects a provider refresh that drops the pinned Organization", async () => {
    const minted: string[][] = [];
    const app = routeApp({
      tokenSigner: {
        ...tokenSigner,
        mintAccessToken: async (_userId, scopes) => {
          minted.push([...scopes]);
          return "must-not-mint";
        },
      },
      repo: duplicateKeyRepo,
      deviceFlow: {
        authorizeDevice: async () => {
          throw new Error("not used");
        },
        exchangeDeviceCode: async () => {
          throw new Error("not used");
        },
        refreshProviderToken: async () => ({
          userId: "user_device",
          refreshToken: "refresh_rotated",
          providerSessionId: "session_isolated",
        }),
        revokeProviderToken: async () => {
          throw new Error("not used");
        },
      },
      deviceRefreshSessions: {
        remember: async () => {},
        lookup: async () => storedSession({ providerOrganizationId: "org_one" }),
        rotate: async () => {},
        forget: async () => {},
      },
    });

    const res = await refreshRequest(app);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
    expect(minted).toEqual([]);
  });
});
