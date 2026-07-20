import { createRepository } from "@splitch/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthApiEnv } from "./env";
import worker from "./index";
import { type LocalBindings, makeLocalBindings } from "./test-fixtures";
import { FIXTURE_TURNSTILE_TOKEN } from "./turnstile";

const AUTH_ORIGIN = "https://auth.splitch.test";
const CONTROL_PLANE_ORIGIN = "https://cp.splitch.test";

let local: LocalBindings;
let env: AuthApiEnv;
let disposeLocal: (() => void) | undefined;

beforeAll(async () => {
  local = await makeLocalBindings();
  disposeLocal = local.dispose;
  env = {
    DB: local.d1,
    JTI_CACHE: local.kv,
    SESSION_STORE: local.sessionKv,
    AUTH_API_ORIGIN: AUTH_ORIGIN,
    CONTROL_PLANE_ORIGIN,
    MCP_ORIGIN: "https://mcp.splitch.test",
    CONTROL_PANEL_ORIGIN: "https://app.splitch.test",
    ASSERTION_SIGNING_SECRET: "test-assertion-secret",
  };
});

afterAll(() => disposeLocal?.());

const testCtx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

describe("Door B Control Plane authorization", () => {
  it("keeps pre-claim member credentials read-only despite live owner memberships", async () => {
    const registration = await registerAnonymous();
    const accessToken = await exchangeForControlPlaneToken(registration.identity_assertion);
    const claims = decodeJwtPayload(accessToken);
    expect(claims).toMatchObject({
      sub: registration.user_id,
      scopes: [`app:${registration.app_id}:member`],
      auth_door: "anonymous",
    });
    await expectOwnerMemberships(registration);

    const controlPlane = await makeControlPlaneApp();
    const appRead = await controlPlane.request(`/apps/${registration.app_id}`, {
      headers: authorization(accessToken),
    });
    expect(appRead.status).toBe(200);

    for (const response of await Promise.all([
      controlPlane.request(`/apps/${registration.app_id}`, {
        method: "PATCH",
        headers: authorization(accessToken, true),
        body: JSON.stringify({ name: "Escalated App" }),
      }),
      controlPlane.request(`/apps/${registration.app_id}`, {
        method: "DELETE",
        headers: authorization(accessToken),
      }),
      controlPlane.request(`/orgs/${registration.org_id}`, {
        method: "PATCH",
        headers: authorization(accessToken, true),
        body: JSON.stringify({ name: "Escalated Org" }),
      }),
      controlPlane.request(`/orgs/${registration.org_id}`, {
        method: "DELETE",
        headers: authorization(accessToken),
      }),
    ])) {
      expect(response.status).toBe(403);
    }
  });
});

async function registerAnonymous(): Promise<Registration> {
  const response = await authFetch(
    new Request(`${AUTH_ORIGIN}/agent/identity`, {
      method: "POST",
      body: JSON.stringify({ turnstile_token: FIXTURE_TURNSTILE_TOKEN }),
    }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Registration;
}

async function exchangeForControlPlaneToken(identityAssertion: string): Promise<string> {
  const response = await authFetch(
    new Request(`${AUTH_ORIGIN}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        identity_assertion: identityAssertion,
        resource: CONTROL_PLANE_ORIGIN,
      }),
    }),
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}

async function expectOwnerMemberships(registration: Registration): Promise<void> {
  const [org, app] = await Promise.all([
    local.d1
      .prepare("SELECT role FROM org_memberships WHERE org_id = ? AND user_id = ?")
      .bind(registration.org_id, registration.user_id)
      .first<{ role: string }>(),
    local.d1
      .prepare("SELECT role FROM app_memberships WHERE app_id = ? AND user_id = ?")
      .bind(registration.app_id, registration.user_id)
      .first<{ role: string }>(),
  ]);
  expect(org?.role).toBe("owner");
  expect(app?.role).toBe("owner");
}

async function makeControlPlaneApp(): Promise<TestApp> {
  const [appModule, authModule, jwksModule, sessionModule] = await Promise.all([
    import(new URL("../../control-plane-api/src/app.ts", import.meta.url).href),
    import(new URL("../../control-plane-api/src/auth-resolver.ts", import.meta.url).href),
    import(new URL("../../control-plane-api/src/jwks-verify.ts", import.meta.url).href),
    import(new URL("../../control-plane-api/src/session-store.ts", import.meta.url).href),
  ]);
  const verifier = jwksModule.makeJwksVerifier({
    fetchJwks: async () => {
      const response = await authFetch(new Request(`${AUTH_ORIGIN}/.well-known/jwks.json`));
      return response.json();
    },
    controlPlaneAudience: CONTROL_PLANE_ORIGIN,
  });
  return appModule.createApp({
    authResolver: authModule.makeControlPlaneAuthResolver({
      verifier,
      sessions: sessionModule.makeSessionStore(local.sessionKv),
    }),
    rateLimiter: () => ({ limited: false }),
    repo: createRepository(local.d1),
  });
}

function authFetch(request: Request): Promise<Response> {
  return Promise.resolve(
    worker.fetch(request as unknown as Parameters<typeof worker.fetch>[0], env, testCtx),
  );
}

function authorization(token: string, json = false): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("missing JWT payload");
  return JSON.parse(
    atob(
      payload
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(payload.length / 4) * 4, "="),
    ),
  ) as Record<string, unknown>;
}

interface Registration {
  identity_assertion: string;
  user_id: string;
  org_id: string;
  app_id: string;
}

interface TestApp {
  request(path: string, init?: RequestInit): Promise<Response>;
}
