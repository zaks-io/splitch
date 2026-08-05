import { createRepository } from "@splitch/db";
import { describe, expect, it } from "vitest";
import type { DeviceFlowPort } from "./device-flow";
import { makeD1DeviceRefreshSessionStore } from "./device-session-store";
import type { MembershipAuthorityRepo } from "./membership-authority";
import { form, routeApp, selectedDeviceCode, unusedRefreshStore } from "./oauth-route-test-harness";
import { makePoolBindings } from "./test-bindings-pool";

function staleMissCache(keys: string[] = []): KVNamespace {
  return {
    async get(_key: string) {
      return null;
    },
    async put(key: string, _value: string) {
      keys.push(key);
    },
  } as unknown as KVNamespace;
}

describe("OAuth revoke route", () => {
  it("fails before calling the provider when a refresh token cannot resolve a session", async () => {
    const providerRevokes: Array<{ token: string; sessionId: string }> = [];
    const app = routeApp({
      deviceFlow: unusedDeviceFlow((params) => providerRevokes.push(params)),
      deviceRefreshSessions: unusedRefreshStore,
    });

    const res = await app.request("/oauth2/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        client_id: "splitch-cli",
        token: "unknown-refresh-token",
        token_type_hint: "refresh_token",
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
    expect(providerRevokes).toEqual([]);
  });

  it("passes the refresh token's provider session id to the provider revoke path", async () => {
    const providerRevokes: Array<{ token: string; sessionId: string }> = [];
    const refreshToken = "provider-refresh-token";
    const app = routeApp({
      deviceFlow: unusedDeviceFlow((params) => providerRevokes.push(params)),
      deviceRefreshSessions: {
        remember: async () => {},
        lookup: async (token) =>
          token === refreshToken
            ? {
                providerSessionId: "session_workos",
                userId: "user_workos",
                providerOrganizationId: "org_selected",
                selectedAppSelector: "app_selected",
              }
            : null,
        rotate: async () => {},
        forget: async () => {},
      },
    });

    const res = await app.request("/oauth2/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        client_id: "splitch-cli",
        token: refreshToken,
        token_type_hint: "refresh_token",
      }),
    });

    expect(res.status).toBe(200);
    expect(providerRevokes).toEqual([{ token: refreshToken, sessionId: "session_workos" }]);
  });

  it("returns the provider refresh token and immediately revokes it through D1 on KV stale miss", async () => {
    const local = await makePoolBindings();
    try {
      const providerRevokes: Array<{ token: string; sessionId: string }> = [];
      const kvKeys: string[] = [];
      const providerRefreshToken = "provider-refresh-token";
      const repo = createRepository(local.d1);
      const deviceRefreshSessions = makeD1DeviceRefreshSessionStore(repo, {
        cache: staleMissCache(kvKeys),
        now: () => 1_780_000_000_000,
      });
      const app = routeApp({
        deviceFlow: {
          ...unusedDeviceFlow((params) => providerRevokes.push(params)),
          exchangeDeviceCode: async () => ({
            userId: "user_workos",
            email: "user_workos@splitch.test",
            organizationId: "org_selected",
            refreshToken: providerRefreshToken,
            providerSessionId: "session_workos",
          }),
        },
        deviceRefreshSessions,
        repo: selectedMembershipRepo(),
      });

      const tokenRes = await app.request("/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: "splitch-cli",
          device_code: await selectedDeviceCode("device-code", "app_selected"),
          scope: "app:app_selected:owner",
        }),
      });
      expect(tokenRes.status).toBe(200);
      const { refresh_token } = (await tokenRes.json()) as { refresh_token: string };
      expect(refresh_token).toBe(providerRefreshToken);

      const revokeRes = await app.request("/oauth2/revoke", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form({
          client_id: "splitch-cli",
          token: refresh_token,
          token_type_hint: "refresh_token",
        }),
      });

      expect(revokeRes.status).toBe(200);
      expect(providerRevokes).toEqual([
        { token: providerRefreshToken, sessionId: "session_workos" },
      ]);
      expect(kvKeys.length).toBeGreaterThan(0);
      expect(kvKeys.every((key) => !key.includes(providerRefreshToken))).toBe(true);
    } finally {
      await local.dispose();
    }
  });
});

function unusedDeviceFlow(
  revoke: (params: { token: string; sessionId: string }) => void,
): DeviceFlowPort {
  return {
    authorizeDevice: async () => {
      throw new Error("not used");
    },
    exchangeDeviceCode: async () => {
      throw new Error("not used");
    },
    refreshProviderToken: async () => {
      throw new Error("not used");
    },
    revokeProviderToken: async (params) => revoke(params),
  };
}

function selectedMembershipRepo(): MembershipAuthorityRepo {
  return {
    identity: {
      listOrgMembershipsForUser: async () => [{ orgId: "org_selected", role: "owner" }],
      listAppsForOrg: async () => [{ id: "app_selected", key: "selected-app" }],
      getAppMembership: async () => ({ role: "owner" }),
      getOrg: async () => null,
    },
  } as unknown as MembershipAuthorityRepo;
}
