import { describe, expect, it } from "vitest";
import { makeWorkOsDeviceFlow } from "./device-flow";

function b64url(value: unknown): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(JSON.stringify(value))) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function jwtWithClaims(claims: Record<string, unknown>): string {
  return `${b64url({ alg: "none", typ: "JWT" })}.${b64url(claims)}.signature`;
}

function expectCall(call: { url: string; init: RequestInit } | undefined): {
  url: string;
  init: RequestInit;
} {
  expect(call).toBeDefined();
  return call as { url: string; init: RequestInit };
}

describe("WorkOS device flow adapter", () => {
  it("returns the WorkOS session id from the device-token response", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (url.endsWith("/authenticate")) {
        return Response.json({
          user: { id: "user_workos" },
          access_token: jwtWithClaims({ sub: "user_workos", sid: "session_workos" }),
          refresh_token: "refresh_original",
        });
      }
      return Response.json({ error: "invalid_request" }, { status: 400 });
    };
    const flow = makeWorkOsDeviceFlow({
      clientId: "client_123",
      baseUrl: "https://api.workos.test/user_management",
      fetcher,
    });

    const token = await flow.exchangeDeviceCode({
      deviceCode: "device_123",
      clientId: "client_123",
    });

    expect(token).toMatchObject({
      userId: "user_workos",
      refreshToken: "refresh_original",
      providerSessionId: "session_workos",
    });
    expect(calls).toHaveLength(1);
    const authenticateCall = expectCall(calls[0]);
    expect(authenticateCall.url).toBe("https://api.workos.test/user_management/authenticate");
    expect(authenticateCall.init.method).toBe("POST");
    expect(authenticateCall.init.headers).toMatchObject({
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(String(authenticateCall.init.body)).toContain(
      "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code",
    );
  });

  it("revokes refresh tokens by calling session revoke without rotating the token first", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (url.endsWith("/sessions/revoke")) {
        return Response.json({});
      }
      return Response.json({ error: "invalid_request" }, { status: 400 });
    };
    const flow = makeWorkOsDeviceFlow({
      clientId: "client_123",
      apiKey: "sk_test_123",
      baseUrl: "https://api.workos.test/user_management",
      fetcher,
    });

    await flow.revokeProviderToken({
      token: "refresh_original",
      sessionId: "session_workos",
    });

    expect(calls).toHaveLength(1);

    const revokeCall = expectCall(calls[0]);
    expect(revokeCall.url).toBe("https://api.workos.test/user_management/sessions/revoke");
    expect(revokeCall.init.method).toBe("POST");
    expect(revokeCall.init.headers).toMatchObject({
      authorization: "Bearer sk_test_123",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(revokeCall.init.body))).toEqual({ session_id: "session_workos" });
  });

  it("fails loudly when WorkOS refresh-token revocation is not configured", async () => {
    const flow = makeWorkOsDeviceFlow({
      clientId: "client_123",
      fetcher: async () => Response.json({}),
    });

    await expect(
      flow.revokeProviderToken({ token: "refresh_original", sessionId: "session_workos" }),
    ).rejects.toMatchObject({
      code: "server_error",
    });
  });

  it("fails device-token exchange when WorkOS cannot identify the refresh-token session", async () => {
    const flow = makeWorkOsDeviceFlow({
      clientId: "client_123",
      apiKey: "sk_test_123",
      fetcher: async () =>
        Response.json({
          user: { id: "user_workos" },
          access_token: jwtWithClaims({ sub: "user_workos" }),
          refresh_token: "refresh_rotated",
        }),
    });

    await expect(
      flow.exchangeDeviceCode({
        deviceCode: "device_123",
        clientId: "client_123",
      }),
    ).rejects.toMatchObject({
      code: "server_error",
    });
  });

  it("does not rotate the refresh token before surfacing a failed session revoke", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (url.endsWith("/sessions/revoke")) {
        return Response.json({ error: "server_error" }, { status: 500 });
      }
      return Response.json({ error: "invalid_request" }, { status: 400 });
    };
    const flow = makeWorkOsDeviceFlow({
      clientId: "client_123",
      apiKey: "sk_test_123",
      baseUrl: "https://api.workos.test/user_management",
      fetcher,
    });

    await expect(
      flow.revokeProviderToken({ token: "refresh_original", sessionId: "session_workos" }),
    ).rejects.toMatchObject({ code: "server_error" });

    expect(calls).toHaveLength(1);
    expect(calls.some((call) => call.url.endsWith("/authenticate"))).toBe(false);
  });
});
