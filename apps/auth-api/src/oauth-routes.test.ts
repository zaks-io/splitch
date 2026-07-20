import { createRepository } from "@splitch/db";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { DeviceFlowPort } from "./device-flow";
import { sealDeviceGrant } from "./device-grant";
import {
  type DeviceRefreshSessionStore,
  makeD1DeviceRefreshSessionStore,
} from "./device-session-store";
import type { MembershipAuthorityRepo } from "./membership-authority";
import { mountOAuthRoutes } from "./oauth-routes";
import { makeLocalBindings } from "./test-fixtures";
import type { TokenSigner } from "./token-exchange";

const tokenSigner = {
  mintIdentityAssertion: async () => "identity-assertion",
  exchangeForAccessToken: async () => "access-token",
  verifyIdentityAssertion: async () => ({ userId: "user_workos", scopes: [] }),
  mintAccessToken: async () => "access-token",
} satisfies TokenSigner;
const revocations = {
  revoke: async () => {},
  isRevoked: async () => false,
};
const emptyMembershipRepo = {
  identity: {
    listOrgMembershipsForUser: async () => [],
    listAppsForOrg: async () => [],
    getAppMembership: async () => null,
  },
} satisfies MembershipAuthorityRepo;

function form(body: Record<string, string>): string {
  return new URLSearchParams(body).toString();
}

function selectedDeviceCode(deviceCode: string, scope: string): Promise<string> {
  return sealDeviceGrant(
    { deviceCode, selectedAppScope: scope, expiresAt: 1_780_000_300_000 },
    "test-access-secret",
  );
}

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

function routeApp(params: {
  deviceFlow: DeviceFlowPort;
  deviceRefreshSessions: DeviceRefreshSessionStore;
  repo?: MembershipAuthorityRepo;
  tokenSigner?: TokenSigner;
}): Hono {
  const app = new Hono();
  mountOAuthRoutes(app, {
    tokenSigner: params.tokenSigner ?? tokenSigner,
    deviceFlow: params.deviceFlow,
    deviceRefreshSessions: params.deviceRefreshSessions,
    revocations,
    accessSecret: "test-access-secret",
    controlPlaneAudience: "https://cp.splitch.test",
    now: () => 1_780_000_000_000,
    repo: params.repo ?? emptyMembershipRepo,
  });
  return app;
}

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
        listAppsForOrg: async () => [{ id: "app_selected" }, { id: "app_victim" }],
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
            scopes: ["app:app_selected:admin", "app:app_victim:admin"],
          };
        },
        revokeProviderToken: async () => {
          throw new Error("not used");
        },
      },
      deviceRefreshSessions: { remember: async () => {}, lookup: async () => null },
    });

    const res = await app.request("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: await selectedDeviceCode("approved", "app:app_selected:admin"),
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
});

describe("OAuth revoke route", () => {
  it("fails before calling the provider when a refresh token cannot resolve a session", async () => {
    const providerRevokes: Array<{ token: string; sessionId: string }> = [];
    const app = routeApp({
      deviceFlow: {
        authorizeDevice: async () => {
          throw new Error("not used");
        },
        exchangeDeviceCode: async () => {
          throw new Error("not used");
        },
        revokeProviderToken: async (params) => {
          providerRevokes.push(params);
        },
      } satisfies DeviceFlowPort,
      deviceRefreshSessions: {
        remember: async () => {},
        lookup: async () => null,
      },
    });

    const res = await app.request("/oauth2/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ token: "unknown-refresh-token", token_type_hint: "refresh_token" }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
    expect(providerRevokes).toEqual([]);
  });

  it("passes the refresh token's provider session id to the provider revoke path", async () => {
    const providerRevokes: Array<{ token: string; sessionId: string }> = [];
    const refreshToken = "provider-refresh-token";
    const app = routeApp({
      deviceFlow: {
        authorizeDevice: async () => {
          throw new Error("not used");
        },
        exchangeDeviceCode: async () => {
          throw new Error("not used");
        },
        revokeProviderToken: async (params) => {
          providerRevokes.push(params);
        },
      } satisfies DeviceFlowPort,
      deviceRefreshSessions: {
        remember: async () => {},
        lookup: async (token) => (token === refreshToken ? "session_workos" : null),
      },
    });

    const res = await app.request("/oauth2/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ token: refreshToken, token_type_hint: "refresh_token" }),
    });

    expect(res.status).toBe(200);
    expect(providerRevokes).toEqual([{ token: refreshToken, sessionId: "session_workos" }]);
  });

  it("returns the provider refresh token and immediately revokes it through D1 on KV stale miss", async () => {
    const local = await makeLocalBindings();
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
          authorizeDevice: async () => {
            throw new Error("not used");
          },
          exchangeDeviceCode: async () => ({
            userId: "user_workos",
            refreshToken: providerRefreshToken,
            providerSessionId: "session_workos",
            scopes: ["app:app_selected:owner"],
          }),
          revokeProviderToken: async (params) => {
            providerRevokes.push(params);
          },
        } satisfies DeviceFlowPort,
        deviceRefreshSessions,
        repo: {
          identity: {
            listOrgMembershipsForUser: async () => [{ orgId: "org_selected", role: "owner" }],
            listAppsForOrg: async () => [{ id: "app_selected" }],
            getAppMembership: async () => ({ role: "owner" }),
          },
        } as unknown as MembershipAuthorityRepo,
      });

      const tokenRes = await app.request("/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: await selectedDeviceCode("device-code", "app:app_selected:owner"),
          scope: "app:app_selected:owner",
        }),
      });
      expect(tokenRes.status).toBe(200);
      const { refresh_token } = (await tokenRes.json()) as { refresh_token: string };
      expect(refresh_token).toBe(providerRefreshToken);

      const revokeRes = await app.request("/oauth2/revoke", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form({ token: refresh_token, token_type_hint: "refresh_token" }),
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
