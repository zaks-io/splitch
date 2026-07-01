import { describe, expect, it } from "vitest";
import { makeWorkOsDeviceFlow } from "./device-flow.js";

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
  it("revokes refresh tokens by resolving the WorkOS session and calling session revoke", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (url.endsWith("/authenticate")) {
        return Response.json({
          user: { id: "user_workos" },
          access_token: jwtWithClaims({ sub: "user_workos", sid: "session_workos" }),
          refresh_token: "refresh_rotated",
        });
      }
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

    await flow.revokeProviderToken("refresh_original");

    expect(calls).toHaveLength(2);
    const authenticateCall = expectCall(calls[0]);
    expect(authenticateCall.url).toBe("https://api.workos.test/user_management/authenticate");
    expect(authenticateCall.init.method).toBe("POST");
    expect(authenticateCall.init.headers).toMatchObject({ "content-type": "application/json" });
    expect(JSON.parse(String(authenticateCall.init.body))).toMatchObject({
      client_id: "client_123",
      client_secret: "sk_test_123",
      grant_type: "refresh_token",
      refresh_token: "refresh_original",
    });

    const revokeCall = expectCall(calls[1]);
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

    await expect(flow.revokeProviderToken("refresh_original")).rejects.toMatchObject({
      code: "server_error",
    });
  });

  it("fails loudly when WorkOS cannot identify the session behind the refresh token", async () => {
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

    await expect(flow.revokeProviderToken("refresh_original")).rejects.toMatchObject({
      code: "server_error",
    });
  });
});
