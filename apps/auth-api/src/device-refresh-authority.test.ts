import { describe, expect, it } from "vitest";
import type { DeviceFlowPort } from "./device-flow";
import type { DeviceRefreshSession } from "./device-session-store";
import type { MembershipAuthorityRepo } from "./membership-authority";
import { form, routeApp, tokenSigner } from "./oauth-route-test-harness";

const memberRepo = {
  identity: {
    listOrgMembershipsForUser: async () => [{ orgId: "org_selected", role: "owner" }],
    listAppsForOrg: async () => [{ id: "app_selected", key: "selected-app" }],
    getAppMembership: async () => ({ role: "member" }),
    getOrg: async () => ({ id: "org_selected", slug: "selected-org" }),
  },
} as unknown as MembershipAuthorityRepo;

const refreshOnlyDeviceFlow = (organizationId?: string): DeviceFlowPort => ({
  authorizeDevice: async () => {
    throw new Error("not used");
  },
  exchangeDeviceCode: async () => {
    throw new Error("not used");
  },
  refreshProviderToken: async () => ({
    userId: "user_device",
    email: "device@splitch.test",
    organizationId,
    refreshToken: "refresh_rotated",
    providerSessionId: "session_selected",
  }),
  revokeProviderToken: async () => {
    throw new Error("not used");
  },
});

function storedSession(overrides: Partial<DeviceRefreshSession> = {}): DeviceRefreshSession {
  return {
    providerSessionId: "session_selected",
    userId: "user_device",
    providerOrganizationId: "org_selected",
    selectedAppSelector: "app_selected",
    ...overrides,
  };
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

describe("OAuth refresh token authority", () => {
  it("rotates refresh authority and mints only after live membership reintersection", async () => {
    const rotations: Array<{ previous: string; next: string; selector: string | null }> = [];
    const minted: string[][] = [];
    const app = routeApp({
      tokenSigner: {
        ...tokenSigner,
        mintAccessToken: async (_userId, scopes) => {
          minted.push([...scopes]);
          return "refreshed-access-token";
        },
      },
      repo: memberRepo,
      deviceFlow: refreshOnlyDeviceFlow("org_selected"),
      deviceRefreshSessions: {
        remember: async () => {},
        lookup: async () => storedSession(),
        rotate: async (previous, next, session) => {
          rotations.push({ previous, next, selector: session.selectedAppSelector });
        },
        forget: async () => {},
      },
    });

    const res = await refreshRequest(app);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      access_token: "refreshed-access-token",
      refresh_token: "refresh_rotated",
      app_id: "app_selected",
    });
    // The live role (member) wins over anything the session ever held.
    expect(minted).toEqual([["app:app_selected:member"]]);
    expect(rotations).toEqual([
      { previous: "refresh_original", next: "refresh_rotated", selector: "app_selected" },
    ]);
  });

  it("mints an unbound token for a cold-start session with no selected App", async () => {
    const minted: string[][] = [];
    const app = routeApp({
      tokenSigner: {
        ...tokenSigner,
        mintAccessToken: async (_userId, scopes) => {
          minted.push([...scopes]);
          return "unbound-access-token";
        },
      },
      repo: memberRepo,
      deviceFlow: refreshOnlyDeviceFlow(),
      deviceRefreshSessions: {
        remember: async () => {},
        lookup: async () =>
          storedSession({ providerOrganizationId: null, selectedAppSelector: null }),
        rotate: async () => {},
        forget: async () => {},
      },
    });

    const res = await refreshRequest(app);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ access_token: "unbound-access-token" });
    expect(body).not.toHaveProperty("app_id");
    expect(minted).toEqual([[]]);
  });

  it("rebinds a mint to a requested App without rewriting the session default", async () => {
    const rotations: Array<string | null> = [];
    const minted: string[][] = [];
    const app = routeApp({
      tokenSigner: {
        ...tokenSigner,
        mintAccessToken: async (_userId, scopes) => {
          minted.push([...scopes]);
          return "rebound-access-token";
        },
      },
      repo: memberRepo,
      deviceFlow: refreshOnlyDeviceFlow(),
      deviceRefreshSessions: {
        remember: async () => {},
        lookup: async () =>
          storedSession({ providerOrganizationId: null, selectedAppSelector: null }),
        rotate: async (_previous, _next, session) => {
          rotations.push(session.selectedAppSelector);
        },
        forget: async () => {},
      },
    });

    const res = await refreshRequest(app, { app: "selected-app" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      access_token: "rebound-access-token",
      app_id: "app_selected",
    });
    expect(minted).toEqual([["app:app_selected:member"]]);
    expect(rotations).toEqual([null]);
  });

  it("rebinds a mint to a requested Organization by slug", async () => {
    const minted: string[][] = [];
    const app = routeApp({
      tokenSigner: {
        ...tokenSigner,
        mintAccessToken: async (_userId, scopes) => {
          minted.push([...scopes]);
          return "org-access-token";
        },
      },
      repo: memberRepo,
      deviceFlow: refreshOnlyDeviceFlow(),
      deviceRefreshSessions: {
        remember: async () => {},
        lookup: async () =>
          storedSession({ providerOrganizationId: null, selectedAppSelector: null }),
        rotate: async () => {},
        forget: async () => {},
      },
    });

    const res = await refreshRequest(app, { org: "selected-org" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ access_token: "org-access-token" });
    expect(body).not.toHaveProperty("app_id");
    expect(minted).toEqual([["org:org_selected:owner"]]);
  });

  it("rejects a rebind to a resource outside live membership", async () => {
    let mintedCount = 0;
    const app = routeApp({
      tokenSigner: {
        ...tokenSigner,
        mintAccessToken: async () => {
          mintedCount += 1;
          return "must-not-mint";
        },
      },
      repo: memberRepo,
      deviceFlow: refreshOnlyDeviceFlow(),
      deviceRefreshSessions: {
        remember: async () => {},
        lookup: async () =>
          storedSession({ providerOrganizationId: null, selectedAppSelector: null }),
        rotate: async () => {},
        forget: async () => {},
      },
    });

    const res = await refreshRequest(app, { app: "someone-elses-app" });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
    expect(mintedCount).toBe(0);
  });
});

describe("OAuth refresh token authority rejections", () => {
  it("rejects a provider refresh that changes the WorkOS Organization grant", async () => {
    let minted = false;
    let rotated = false;
    const app = routeApp({
      tokenSigner: {
        ...tokenSigner,
        mintAccessToken: async () => {
          minted = true;
          return "must-not-mint";
        },
      },
      repo: memberRepo,
      deviceFlow: refreshOnlyDeviceFlow("org_changed"),
      deviceRefreshSessions: {
        remember: async () => {},
        lookup: async () => storedSession(),
        rotate: async () => {
          rotated = true;
        },
        forget: async () => {},
      },
    });

    const res = await refreshRequest(app);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
    expect(minted).toBe(false);
    expect(rotated).toBe(false);
  });

  it("rejects an unknown client_id before touching the provider", async () => {
    let providerCalled = false;
    const app = routeApp({
      repo: memberRepo,
      deviceFlow: {
        ...refreshOnlyDeviceFlow(),
        refreshProviderToken: async () => {
          providerCalled = true;
          throw new Error("must not reach the provider");
        },
      },
      deviceRefreshSessions: {
        remember: async () => {},
        lookup: async () => storedSession(),
        rotate: async () => {},
        forget: async () => {},
      },
    });

    const res = await refreshRequest(app, { client_id: "not-splitch" });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("invalid_client");
    expect(body.error_description).toContain("not-splitch");
    expect(providerCalled).toBe(false);
  });
});
