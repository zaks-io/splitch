import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeEphemeralAccessTokenPrivateJwk } from "./access-token-key";
import type { AuthApiEnv } from "./env";
import worker from "./index";
import { makePoolBindings } from "./test-bindings-pool";
import type { LocalBindings } from "./test-fixtures";

const configuredOrigin = "https://configured-auth.splitch.test";
const requestOrigin = "https://request-host.splitch.test";
const testCtx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

let local: LocalBindings;
let accessTokenSecret: string;
let assertionSigningSecret: string;

beforeAll(async () => {
  local = await makePoolBindings();
  accessTokenSecret = await makeEphemeralAccessTokenPrivateJwk();
  assertionSigningSecret = `hosted-uncommitted-${crypto.randomUUID()}`;
});

afterAll(() => local.dispose());

function hostedEnv(authApiOrigin: string | undefined): AuthApiEnv {
  return {
    DB: local.d1,
    JTI_CACHE: local.kv,
    SESSION_STORE: local.sessionKv,
    AUTH_API_ORIGIN: authApiOrigin,
    CONTROL_PLANE_ORIGIN: "https://cp.splitch.test",
    CONTROL_PANEL_ORIGIN: "https://app.splitch.test",
    SPLITCH_PLATFORM_TARGET: "shared-preview",
    SPLITCH_DEPLOYED_COMMIT_SHA: "a".repeat(40),
    ACCESS_TOKEN_SECRET: accessTokenSecret,
    ASSERTION_SIGNING_SECRET: assertionSigningSecret,
    WORKOS_API_KEY: "test-workos-api-key",
    WORKOS_CLIENT_ID: "test-workos-client-id",
    WORKOS_JWKS_URI: "https://api.workos.test/jwks",
    WORKOS_ISSUER: "https://api.workos.test",
    TURNSTILE_SECRET: "test-turnstile-secret",
    SPLITCH_SMOKE_CLIENT_ID: "configured-origin-smoke",
    SPLITCH_SMOKE_CLIENT_SECRET: "configured-origin-secret",
    SPLITCH_SMOKE_USER_ID: "user_configured_origin",
    SPLITCH_SMOKE_SCOPES: "org:org_configured_origin:owner",
  };
}

function fetchWorker(request: Request, env: AuthApiEnv): Promise<Response> {
  return Promise.resolve(
    worker.fetch(request as unknown as Parameters<typeof worker.fetch>[0], env, testCtx),
  );
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("missing JWT payload");
  const padded = payload
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(payload.length / 4) * 4, "=");
  return JSON.parse(atob(padded)) as Record<string, unknown>;
}

describe("Auth API origin runtime configuration", () => {
  it.each([
    ["missing", undefined],
    ["not a URL", "not-an-origin"],
    ["a path", "https://auth.splitch.test/path"],
    ["a trailing slash", "https://auth.splitch.test/"],
    ["credentials", "https://user:password@auth.splitch.test"],
    ["hosted HTTP", "http://auth.splitch.test"],
  ])("rejects %s config on health and auth routes", async (_label, authApiOrigin) => {
    const env = hostedEnv(authApiOrigin);
    for (const path of ["/health", "/agent/identity"]) {
      const init =
        path === "/health"
          ? undefined
          : {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ turnstile_token: "unused" }),
            };
      const response = await fetchWorker(new Request(`${requestOrigin}${path}`, init), env);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "server_error",
        error_description: "AUTH_API_ORIGIN must be a canonical Auth API origin",
      });
    }
  });

  it("uses the configured origin for discovery, minting, and verification", async () => {
    const env = hostedEnv(configuredOrigin);
    const discovery = await fetchWorker(
      new Request(`${requestOrigin}/.well-known/oauth-authorization-server`),
      env,
    );
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toMatchObject({
      issuer: configuredOrigin,
      jwks_uri: `${configuredOrigin}/.well-known/jwks.json`,
      token_endpoint: `${configuredOrigin}/oauth2/token`,
      agent_auth: {
        skill: `${configuredOrigin}/auth.md`,
        identity_endpoint: `${configuredOrigin}/agent/identity`,
      },
    });

    const tokenResponse = await fetchWorker(
      new Request(`${requestOrigin}/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: "configured-origin-smoke",
          client_secret: "configured-origin-secret",
        }),
      }),
      env,
    );
    expect(tokenResponse.status).toBe(200);
    const { access_token: accessToken } = (await tokenResponse.json()) as {
      access_token: string;
    };
    expect(decodeJwtPayload(accessToken).iss).toBe(configuredOrigin);

    const protectedResponse = await fetchWorker(
      new Request(`${requestOrigin}/orgs/org_configured_origin/trusted-idps`, {
        headers: { authorization: `Bearer ${accessToken}` },
      }),
      env,
    );
    expect(protectedResponse.status).toBe(403);
  });
});
