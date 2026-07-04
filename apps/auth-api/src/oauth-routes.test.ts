import { createRepository } from "@splitch/db";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { DeviceFlowPort } from "./device-flow";
import {
  type DeviceRefreshSessionStore,
  makeD1DeviceRefreshSessionStore,
} from "./device-session-store";
import { mountOAuthRoutes } from "./oauth-routes";
import type { TokenSigner } from "./token-exchange";
import { makeLocalBindings } from "./test-fixtures";

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

function form(body: Record<string, string>): string {
  return new URLSearchParams(body).toString();
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
}): Hono {
  const app = new Hono();
  mountOAuthRoutes(app, {
    tokenSigner,
    deviceFlow: params.deviceFlow,
    deviceRefreshSessions: params.deviceRefreshSessions,
    revocations,
    accessSecret: "test-access-secret",
    controlPlaneAudience: "https://cp.splitch.test",
    now: () => 1_780_000_000_000,
  });
  return app;
}

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
            scopes: [],
          }),
          revokeProviderToken: async (params) => {
            providerRevokes.push(params);
          },
        } satisfies DeviceFlowPort,
        deviceRefreshSessions,
      });

      const tokenRes = await app.request("/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: "device-code",
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
