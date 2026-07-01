import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { DeviceFlowPort } from "./device-flow.js";
import { mountOAuthRoutes } from "./oauth-routes.js";
import type { TokenSigner } from "./token-exchange.js";

const tokenSigner = {} as TokenSigner;
const revocations = {
  revoke: async () => {},
  isRevoked: async () => false,
};

function form(body: Record<string, string>): string {
  return new URLSearchParams(body).toString();
}

describe("OAuth revoke route", () => {
  it("fails before calling the provider when a refresh-token session mapping is missing", async () => {
    const providerRevokes: Array<{ token: string; sessionId: string }> = [];
    const app = new Hono();
    mountOAuthRoutes(app, {
      tokenSigner,
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
      revocations,
      accessSecret: "test-access-secret",
      controlPlaneAudience: "https://cp.splitch.test",
      now: () => 1_780_000_000_000,
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

  it("passes the stored provider session id to the provider revoke path", async () => {
    const providerRevokes: Array<{ token: string; sessionId: string }> = [];
    const app = new Hono();
    mountOAuthRoutes(app, {
      tokenSigner,
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
        lookup: async () => "session_workos",
      },
      revocations,
      accessSecret: "test-access-secret",
      controlPlaneAudience: "https://cp.splitch.test",
      now: () => 1_780_000_000_000,
    });

    const res = await app.request("/oauth2/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ token: "known-refresh-token", token_type_hint: "refresh_token" }),
    });

    expect(res.status).toBe(200);
    expect(providerRevokes).toEqual([
      { token: "known-refresh-token", sessionId: "session_workos" },
    ]);
  });
});
