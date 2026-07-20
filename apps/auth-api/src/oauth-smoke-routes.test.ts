import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { DeviceFlowPort } from "./device-flow";
import type { MembershipAuthorityRepo } from "./membership-authority";
import { mountOAuthRoutes } from "./oauth-routes";
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

async function privateRsaJwkSecret(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  return JSON.stringify({ ...jwk, kid: "test-access-key", alg: "RS256", use: "sig" });
}

function unusedDeviceFlow(): DeviceFlowPort {
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
    revokeProviderToken: async () => {
      throw new Error("not used");
    },
  };
}

function routeApp(params: {
  tokenSigner?: TokenSigner;
  accessSecret?: string;
  smokeClientCredentials?: {
    clientId: string;
    clientSecret: string;
    userId: string;
    scopes: string[];
  };
}): Hono {
  const app = new Hono();
  mountOAuthRoutes(app, {
    tokenSigner: params.tokenSigner ?? tokenSigner,
    deviceFlow: unusedDeviceFlow(),
    deviceRefreshSessions: {
      remember: async () => {},
      lookup: async () => null,
      rotate: async () => {},
      forget: async () => {},
    },
    revocations,
    accessSecret: params.accessSecret ?? "test-access-secret",
    controlPlaneAudience: "https://cp.splitch.test",
    mcpAudience: "https://mcp.splitch.test",
    smokeClientCredentials: params.smokeClientCredentials,
    now: () => 1_780_000_000_000,
    repo: emptyMembershipRepo,
  });
  return app;
}

describe("OAuth access-token JWKS", () => {
  it("advertises the access-token JWKS in authorization-server metadata", async () => {
    const app = routeApp({});

    const res = await app.request("/.well-known/oauth-authorization-server");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      issuer: "http://localhost",
      jwks_uri: "http://localhost/.well-known/jwks.json",
    });
  });

  it("publishes the public access-token key when ACCESS_TOKEN_SECRET is an RSA private JWK", async () => {
    const app = routeApp({ accessSecret: await privateRsaJwkSecret() });

    const res = await app.request("/.well-known/jwks.json");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: Array<Record<string, unknown>> };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({ kty: "RSA", kid: "test-access-key", alg: "RS256" });
    expect(body.keys[0]?.d).toBeUndefined();
  });

  it("fails closed instead of publishing JWKS for a symmetric access-token secret", async () => {
    const app = routeApp({ accessSecret: "test-access-secret" });

    const res = await app.request("/.well-known/jwks.json");

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "access-token JWKS is not configured" });
  });
});

describe("OAuth smoke client_credentials route", () => {
  it("mints only the exact configured MCP protected resource", async () => {
    const audiences: Array<string | undefined> = [];
    const signer = {
      ...tokenSigner,
      mintAccessToken: async (
        _userId: string,
        _scopes: string[],
        _door: "client_credentials",
        _now: number,
        audience?: string,
      ) => {
        audiences.push(audience);
        return "mcp-access-token";
      },
    } satisfies TokenSigner;
    const app = routeApp({
      tokenSigner: signer,
      smokeClientCredentials: {
        clientId: "smoke",
        clientSecret: "secret",
        userId: "user_smoke",
        scopes: ["app:app_smoke:admin"],
      },
    });

    const accepted = await app.request("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "client_credentials",
        client_id: "smoke",
        client_secret: "secret",
        resource: "https://mcp.splitch.test/mcp",
      }),
    });
    expect(accepted.status).toBe(200);
    expect(audiences).toEqual(["https://mcp.splitch.test/mcp"]);

    const rejected = await app.request("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "client_credentials",
        client_id: "smoke",
        client_secret: "secret",
        resource: "https://attacker.test",
      }),
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: "invalid_request" });
    expect(audiences).toHaveLength(1);
  });

  it("does not advertise client_credentials without the shared-preview smoke client", async () => {
    const app = routeApp({});

    const discovery = await app.request("/.well-known/oauth-authorization-server");
    expect(discovery.status).toBe(200);
    const metadata = (await discovery.json()) as {
      grant_types_supported: string[];
      token_endpoint_auth_methods_supported: string[];
    };
    expect(metadata.grant_types_supported).not.toContain("client_credentials");
    expect(metadata.token_endpoint_auth_methods_supported).not.toContain("client_secret_post");

    const token = await app.request("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "client_credentials",
        client_id: "splitch-shared-preview-smoke",
        client_secret: "smoke-secret",
      }),
    });
    expect(token.status).toBe(400);
    expect(await token.json()).toMatchObject({ error: "unsupported_grant_type" });
  });

  it("mints an access token for the configured shared-preview smoke client", async () => {
    const minted: Array<{ userId: string; scopes: string[]; authDoor: string }> = [];
    const signer = {
      ...tokenSigner,
      mintAccessToken: async (userId, scopes, authDoor) => {
        minted.push({ userId, scopes, authDoor });
        return "smoke-access-token";
      },
    } satisfies TokenSigner;
    const app = routeApp({
      tokenSigner: signer,
      smokeClientCredentials: {
        clientId: "splitch-shared-preview-smoke",
        clientSecret: "smoke-secret",
        userId: "user_shared_preview_smoke",
        scopes: ["app:smoke-auth-missing-app:member"],
      },
    });

    const res = await app.request("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "client_credentials",
        client_id: "splitch-shared-preview-smoke",
        client_secret: "smoke-secret",
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      access_token: "smoke-access-token",
      token_type: "Bearer",
      expires_in: 3600,
    });
    expect(minted).toEqual([
      {
        userId: "user_shared_preview_smoke",
        scopes: ["app:smoke-auth-missing-app:member"],
        authDoor: "client_credentials",
      },
    ]);
  });

  it("rejects invalid shared-preview smoke client credentials", async () => {
    const app = routeApp({
      smokeClientCredentials: {
        clientId: "splitch-shared-preview-smoke",
        clientSecret: "smoke-secret",
        userId: "user_shared_preview_smoke",
        scopes: ["app:smoke-auth-missing-app:member"],
      },
    });

    const res = await app.request("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "client_credentials",
        client_id: "splitch-shared-preview-smoke",
        client_secret: "wrong-secret",
      }),
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "invalid_client" });
  });
});
