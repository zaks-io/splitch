import { describe, expect, it, vi } from "vitest";
import { makeRateLimiter } from "./rate-limit";
import { form, routeApp, unusedRefreshStore } from "./oauth-route-test-harness";

describe("device authorization rate limit", () => {
  it("rejects before the outbound provider call", async () => {
    const authorizeDevice = vi.fn(async () => ({
      device_code: "device-code",
      user_code: "ABCD-EFGH",
      verification_uri: "https://authenticate.workos.test",
      verification_uri_complete: "https://authenticate.workos.test?code=ABCD-EFGH",
      expires_in: 600,
      interval: 5,
    }));
    const app = routeApp({
      deviceFlow: {
        authorizeDevice,
        exchangeDeviceCode: async () => {
          throw new Error("not used");
        },
        refreshProviderToken: async () => {
          throw new Error("not used");
        },
        revokeProviderToken: async () => {
          throw new Error("not used");
        },
      },
      deviceRefreshSessions: unusedRefreshStore,
      deviceAuthorizationRateLimiter: makeRateLimiter({ perIpPerHour: 1, globalPerHour: 100 }),
    });
    const request = () =>
      app.request("/oauth2/device_authorization", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "cf-connecting-ip": "203.0.113.4",
        },
        body: form({ client_id: "splitch-cli" }),
      });

    expect((await request()).status).toBe(200);
    const rejected = await request();
    expect(rejected.status).toBe(429);
    expect(await rejected.json()).toMatchObject({ error: "too_many_requests" });
    expect(authorizeDevice).toHaveBeenCalledOnce();
  });

  it("does not charge malformed or unknown-client requests", async () => {
    const assertUnderCeiling = vi.fn();
    const app = routeApp({
      deviceFlow: {
        authorizeDevice: async () => {
          throw new Error("not used");
        },
        exchangeDeviceCode: async () => {
          throw new Error("not used");
        },
        refreshProviderToken: async () => {
          throw new Error("not used");
        },
        revokeProviderToken: async () => {
          throw new Error("not used");
        },
      },
      deviceRefreshSessions: unusedRefreshStore,
      deviceAuthorizationRateLimiter: { assertUnderCeiling },
    });

    const malformed = await app.request("/oauth2/device_authorization", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "client_id=",
    });
    expect(malformed.status).toBe(400);
    expect(assertUnderCeiling).not.toHaveBeenCalled();
  });
});
