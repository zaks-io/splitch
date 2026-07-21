import { describe, expect, it, vi } from "vitest";
import { deviceAuthorizationRequestForApp } from "./device-authorization-contract";
import type { DeviceFlowPort } from "./device-flow";
import { routeApp, unusedRefreshStore } from "./oauth-route-test-harness";

describe("shared-preview Device Authorization contract", () => {
  it("executes the smoke request through the real OAuth route schema", async () => {
    const authorizeDevice = vi.fn(async () => ({
      device_code: "provider-device-code",
      user_code: "SPLT-CH25",
      verification_uri: "https://auth.splitch.test/device",
      expires_in: 300,
    }));
    const deviceFlow = {
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
    } satisfies DeviceFlowPort;
    const app = routeApp({ deviceFlow, deviceRefreshSessions: unusedRefreshStore });

    const response = await app.request("/oauth2/device_authorization", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...deviceAuthorizationRequestForApp("app_shared_preview_smoke"),
      }).toString(),
    });

    expect(response.status).toBe(200);
    expect(authorizeDevice).toHaveBeenCalledOnce();
  });
});
