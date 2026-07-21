import { describe, expect, it } from "vitest";
import type { MembershipAuthorityRepo } from "./membership-authority";
import {
  form,
  routeApp,
  selectedDeviceCode,
  tokenSigner,
  unusedRefreshStore,
} from "./oauth-route-test-harness";
import type { TokenSigner } from "./token-exchange";

describe("OAuth device token authority", () => {
  it("mints only requested scopes backed by the authenticated User's live memberships", async () => {
    const minted: Array<{ userId: string; scopes: string[]; authDoor: string; audience?: string }> =
      [];
    const signer = {
      ...tokenSigner,
      mintAccessToken: async (userId, scopes, authDoor, _nowSeconds, audience) => {
        minted.push({ userId, scopes, authDoor, audience });
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
      },
    } as unknown as MembershipAuthorityRepo;
    const app = routeApp({
      repo,
      tokenSigner: signer,
      deviceFlow: {
        authorizeDevice: async () => {
          throw new Error("not used");
        },
        exchangeDeviceCode: async (params) => {
          expect(params).toEqual({ clientId: undefined, deviceCode: "approved" });
          return {
            userId: "user_device",
            organizationId: "org_selected",
            refreshToken: "refresh_selected",
            providerSessionId: "session_selected",
          };
        },
        refreshProviderToken: async () => {
          throw new Error("not used");
        },
        revokeProviderToken: async () => {
          throw new Error("not used");
        },
      },
      deviceRefreshSessions: unusedRefreshStore,
    });

    const res = await app.request("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: await selectedDeviceCode("approved", "app_selected", "admin"),
        scope: "app:app_selected:admin",
        resource: "https://cp.splitch.test",
      }),
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

  it("rejects a selected App outside the WorkOS Organization grant", async () => {
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
          listOrgMembershipsForUser: async () => [{ orgId: "org_victim", role: "owner" }],
          listAppsForOrg: async (orgId: string) =>
            orgId === "org_victim" ? [{ id: "app_victim", key: "victim-app" }] : [],
          getAppMembership: async () => ({ role: "owner" }),
        },
      } as unknown as MembershipAuthorityRepo,
      deviceFlow: {
        authorizeDevice: async () => {
          throw new Error("not used");
        },
        exchangeDeviceCode: async () => ({
          userId: "user_device",
          organizationId: "org_provider",
          refreshToken: "refresh_provider",
          providerSessionId: "session_provider",
        }),
        refreshProviderToken: async () => {
          throw new Error("not used");
        },
        revokeProviderToken: async () => {
          throw new Error("not used");
        },
      },
      deviceRefreshSessions: unusedRefreshStore,
    });

    const res = await app.request("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: await selectedDeviceCode("approved", "app_victim", "owner"),
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
    expect(minted).toBe(false);
  });
});
