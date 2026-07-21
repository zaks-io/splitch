import { describe, expect, it } from "vitest";
import type { MembershipAuthorityRepo } from "./membership-authority";
import { form, routeApp, tokenSigner } from "./oauth-route-test-harness";

describe("OAuth refresh token authority", () => {
  it("rotates refresh authority and mints only after live membership reintersection", async () => {
    const rotations: Array<{ previous: string; next: string; scope: string }> = [];
    const minted: string[][] = [];
    const app = routeApp({
      tokenSigner: {
        ...tokenSigner,
        mintAccessToken: async (_userId, scopes) => {
          minted.push(scopes);
          return "refreshed-access-token";
        },
      },
      repo: {
        identity: {
          listOrgMembershipsForUser: async () => [{ orgId: "org_selected", role: "owner" }],
          listAppsForOrg: async () => [{ id: "app_selected", key: "selected-app" }],
          getAppMembership: async () => ({ role: "member" }),
        },
      } as unknown as MembershipAuthorityRepo,
      deviceFlow: {
        authorizeDevice: async () => {
          throw new Error("not used");
        },
        exchangeDeviceCode: async () => {
          throw new Error("not used");
        },
        refreshProviderToken: async () => ({
          userId: "user_device",
          organizationId: "org_selected",
          refreshToken: "refresh_rotated",
          providerSessionId: "session_selected",
        }),
        revokeProviderToken: async () => {
          throw new Error("not used");
        },
      },
      deviceRefreshSessions: {
        remember: async () => {},
        lookup: async () => ({
          providerSessionId: "session_selected",
          userId: "user_device",
          providerOrganizationId: "org_selected",
          selectedAppScope: "app:app_selected:owner",
        }),
        rotate: async (previous, next, session) => {
          rotations.push({ previous, next, scope: session.selectedAppScope });
        },
        forget: async () => {},
      },
    });

    const res = await app.request("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "refresh_token",
        refresh_token: "refresh_original",
        client_id: "splitch-cli",
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      access_token: "refreshed-access-token",
      refresh_token: "refresh_rotated",
      app_id: "app_selected",
    });
    expect(minted).toEqual([["app:app_selected:member"]]);
    expect(rotations).toEqual([
      {
        previous: "refresh_original",
        next: "refresh_rotated",
        scope: "app:app_selected:member",
      },
    ]);
  });

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
      deviceFlow: {
        authorizeDevice: async () => {
          throw new Error("not used");
        },
        exchangeDeviceCode: async () => {
          throw new Error("not used");
        },
        refreshProviderToken: async () => ({
          userId: "user_device",
          organizationId: "org_changed",
          refreshToken: "refresh_rotated",
          providerSessionId: "session_selected",
        }),
        revokeProviderToken: async () => {
          throw new Error("not used");
        },
      },
      deviceRefreshSessions: {
        remember: async () => {},
        lookup: async () => ({
          providerSessionId: "session_selected",
          userId: "user_device",
          providerOrganizationId: "org_selected",
          selectedAppScope: "app:app_selected:owner",
        }),
        rotate: async () => {
          rotated = true;
        },
        forget: async () => {},
      },
    });

    const res = await app.request("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "refresh_token",
        refresh_token: "refresh_original",
        client_id: "splitch-cli",
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
    expect(minted).toBe(false);
    expect(rotated).toBe(false);
  });
});
