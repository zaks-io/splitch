import { describe, expect, it } from "vitest";
import type { DeviceFlowPort } from "./device-flow";
import type { DeviceRefreshSession } from "./device-session-store";
import type { MembershipAuthorityRepo } from "./membership-authority";
import {
  form,
  routeApp,
  selectedDeviceCode,
  tokenSigner,
  unusedRefreshStore,
} from "./oauth-route-test-harness";
import type { TokenSigner } from "./token-exchange";

const exchangeOnlyDeviceFlow = (organizationId?: string): DeviceFlowPort => ({
  authorizeDevice: async () => {
    throw new Error("not used");
  },
  exchangeDeviceCode: async () => ({
    userId: "user_device",
    email: "device@splitch.test",
    organizationId,
    refreshToken: "refresh_selected",
    providerSessionId: "session_selected",
  }),
  refreshProviderToken: async () => {
    throw new Error("not used");
  },
  revokeProviderToken: async () => {
    throw new Error("not used");
  },
});

function deviceCodeRequest(app: ReturnType<typeof routeApp>, extra: Record<string, string>) {
  return app.request("/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: "splitch-cli",
      ...extra,
    }),
  });
}

describe("OAuth device token authority", () => {
  it("mints only requested scopes backed by the authenticated User's live memberships", async () => {
    const minted: Array<{ userId: string; scopes: string[]; authDoor: string; audience?: string }> =
      [];
    const signer = {
      ...tokenSigner,
      mintAccessToken: async (userId, scopes, authDoor, _nowSeconds, audience) => {
        minted.push({ userId, scopes: [...scopes], authDoor, audience });
        return "membership-bound-token";
      },
    } satisfies TokenSigner;
    const repo = {
      identity: {
        listOrgMembershipsForUser: async () => [{ orgId: "org_selected", role: "owner" }],
        listAppsForOrg: async () => [
          { id: "app_other", key: "app_selected" },
          { id: "app_selected", key: "selected-app" },
          { id: "app_victim", key: "victim-app" },
        ],
        getAppMembership: async (scope: { appId: string }) =>
          scope.appId === "app_selected" ? { role: "admin" } : null,
        getOrg: async () => null,
      },
    } as unknown as MembershipAuthorityRepo;
    const app = routeApp({
      repo,
      tokenSigner: signer,
      deviceFlow: exchangeOnlyDeviceFlow("org_selected"),
      deviceRefreshSessions: unusedRefreshStore,
    });

    const res = await deviceCodeRequest(app, {
      device_code: await selectedDeviceCode("approved", "app_selected"),
      scope: "app:app_selected:admin",
      resource: "https://cp.splitch.test",
    });

    expect(res.status).toBe(200);
    expect(minted).toEqual([
      {
        userId: "user_device",
        scopes: ["app:app_selected:admin"],
        authDoor: "device_flow",
        audience: "https://cp.splitch.test",
      },
    ]);
  });

  it("mints an unbound cold-start token when the login named no App", async () => {
    const minted: string[][] = [];
    const remembered: DeviceRefreshSession[] = [];
    const app = routeApp({
      tokenSigner: {
        ...tokenSigner,
        mintAccessToken: async (_userId, scopes) => {
          minted.push([...scopes]);
          return "cold-start-token";
        },
      },
      deviceFlow: exchangeOnlyDeviceFlow(),
      deviceRefreshSessions: {
        ...unusedRefreshStore,
        remember: async (_token, session) => {
          remembered.push(session);
        },
      },
    });

    const res = await deviceCodeRequest(app, {
      device_code: await selectedDeviceCode("approved", null),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      access_token: "cold-start-token",
      user_id: "user_device",
      email: "device@splitch.test",
    });
    expect(body).not.toHaveProperty("app_id");
    expect(minted).toEqual([[]]);
    expect(remembered).toEqual([
      {
        providerSessionId: "session_selected",
        userId: "user_device",
        providerOrganizationId: null,
        selectedAppSelector: null,
      },
    ]);
  });

  it("rejects a selected App the User's live memberships cannot reach", async () => {
    let minted = false;
    const app = routeApp({
      tokenSigner: {
        ...tokenSigner,
        mintAccessToken: async () => {
          minted = true;
          return "must-not-mint";
        },
      },
      repo: {
        identity: {
          listOrgMembershipsForUser: async () => [{ orgId: "org_user", role: "owner" }],
          listAppsForOrg: async (orgId: string) =>
            orgId === "org_user" ? [{ id: "app_user", key: "user-app" }] : [],
          getAppMembership: async () => ({ role: "owner" }),
          getOrg: async () => null,
        },
      } as unknown as MembershipAuthorityRepo,
      deviceFlow: exchangeOnlyDeviceFlow("org_provider"),
      deviceRefreshSessions: unusedRefreshStore,
    });

    const res = await deviceCodeRequest(app, {
      device_code: await selectedDeviceCode("approved", "app_victim"),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
    expect(minted).toBe(false);
  });

  it("rejects a selected App in a reachable Org without live App membership", async () => {
    let minted = false;
    const app = routeApp({
      tokenSigner: {
        ...tokenSigner,
        mintAccessToken: async () => {
          minted = true;
          return "must-not-mint";
        },
      },
      repo: {
        identity: {
          listOrgMembershipsForUser: async () => [{ orgId: "org_user", role: "member" }],
          listAppsForOrg: async () => [{ id: "app_gated", key: "gated-app" }],
          getAppMembership: async () => null,
          getOrg: async () => null,
        },
      } as unknown as MembershipAuthorityRepo,
      deviceFlow: exchangeOnlyDeviceFlow(),
      deviceRefreshSessions: unusedRefreshStore,
    });

    const res = await deviceCodeRequest(app, {
      device_code: await selectedDeviceCode("approved", "app_gated"),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
    expect(minted).toBe(false);
  });

  it("rejects an unknown client_id before opening the device grant", async () => {
    const app = routeApp({
      deviceFlow: exchangeOnlyDeviceFlow(),
      deviceRefreshSessions: unusedRefreshStore,
    });

    const res = await deviceCodeRequest(app, {
      client_id: "evil-cli",
      device_code: await selectedDeviceCode("approved", null),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("invalid_client");
    expect(body.error_description).toContain("evil-cli");
  });
});
