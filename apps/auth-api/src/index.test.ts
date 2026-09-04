import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { makeEphemeralAccessTokenPrivateJwk } from "./access-token-key";
import type { AuthApiEnv } from "./env";
import worker, { committedAssertionSigningSecrets } from "./index";
import { FIXTURE_OTP } from "./otp";
import { makePoolBindings } from "./test-bindings-pool";
import type { LocalBindings } from "./test-fixtures";
import { FIXTURE_TURNSTILE_TOKEN } from "./turnstile";

/**
 * Worker-entry (index.ts) WIRING test — proves the in-memory fixtures are MODULE
 * scoped, so their state spans SEPARATE requests within an isolate.
 *
 * This drives the REAL exported `worker.fetch` once per request (not initiateClaim/
 * verifyClaim on one shared `deps` object), because the regression was wiring, not
 * logic: when the fixtures were built INSIDE fetch they were rebuilt per request,
 * so the OTP issued at /claim initiate was gone by the verify request and the rate
 * ceiling reset every call. With module-scoped fixtures the OTP survives across
 * requests (verify succeeds) and the ceiling accumulates.
 *
 * The module fixtures are global to the isolate, so each test uses a UNIQUE remote
 * IP to keep its rate-ceiling bucket independent.
 */

let local: LocalBindings;
let env: AuthApiEnv;
/**
 * Hosted targets sign RS256, so the fixture must be a real RSA private JWK. An
 * opaque placeholder here used to boot fine and fail on every mint, which is the
 * shape production actually shipped in.
 */
let hostedAccessTokenSecret: string;
/**
 * Unique per isolate so hosted fixtures never inherit a committed known HMAC
 * key. The reviewer reproduction used the inherited `test-assertion-secret`.
 */
let hostedAssertionSigningSecret: string;

beforeAll(async () => {
  hostedAccessTokenSecret = await makeEphemeralAccessTokenPrivateJwk();
  hostedAssertionSigningSecret = `hosted-uncommitted-${crypto.randomUUID()}`;
  local = await makePoolBindings();
  env = {
    DB: local.d1,
    JTI_CACHE: local.kv,
    SESSION_STORE: local.sessionKv,
    AUTH_API_ORIGIN: "https://auth.splitch.test",
    CONTROL_PLANE_ORIGIN: "https://cp.splitch.test",
    CONTROL_PANEL_ORIGIN: "https://app.splitch.test",
    SPLITCH_PLATFORM_TARGET: "local",
    ASSERTION_SIGNING_SECRET: "test-assertion-secret",
  };
});

afterAll(() => local.dispose());
afterEach(() => vi.unstubAllGlobals());

const testCtx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

function call(
  body: unknown,
  ip: string,
  path = "/agent/identity",
  requestEnv: AuthApiEnv = env,
): Promise<Response> {
  const request = new Request(`https://auth.splitch.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify(body),
  });
  // The handler's typed param is the Cloudflare IncomingRequest (carries `cf`);
  // a plain test Request lacks those edge-only props, so cast at the boundary —
  // the handler reads only headers/url/body, never `cf`.
  return Promise.resolve(
    worker.fetch(request as unknown as Parameters<typeof worker.fetch>[0], requestEnv, testCtx),
  );
}

async function rowCount(table: string): Promise<number> {
  const row = await local.d1.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

let turnstileSeq = 0;
function turnstileToken(): string {
  turnstileSeq += 1;
  return `${FIXTURE_TURNSTILE_TOKEN}-${turnstileSeq}`;
}

describe("index.ts: module-scoped fixtures persist state across requests", () => {
  it("an OTP issued at initiate is still live at verify in a SEPARATE request", async () => {
    const ip = "198.51.100.10";
    // Request 1: register → provisional identity_assertion.
    const reg = (await call({ turnstile_token: turnstileToken() }, ip)) as Response;
    expect(reg.status).toBe(200);
    const { identity_assertion } = (await reg.json()) as { identity_assertion: string };

    // Request 2: claim INITIATE (no otp) — issues the OTP into the module fixture.
    const email = "wiring@example.com";
    const initiate = await call({ identity_assertion, email }, ip, "/claim");
    expect(initiate.status).toBe(200);
    expect((await initiate.json()) as { otp_required: boolean }).toMatchObject({
      otp_required: true,
    });

    // Request 3: claim VERIFY (separate request) — only passes if the OTP from
    // request 2 SURVIVED. Per-request fixture construction loses it → invalid_grant.
    const verify = await call(
      { identity_assertion, email, otp: FIXTURE_OTP, idempotency_key: "wire-key" },
      ip,
      "/claim",
    );
    expect(verify.status).toBe(200);
    const result = (await verify.json()) as { access_token: string; org_id: string };
    expect(result.access_token.split(".")).toHaveLength(3);
  });

  it("the per-IP rate ceiling accumulates across separate requests", async () => {
    // Default ceiling is 10/IP/hr. Exhaust it from one IP across SEPARATE requests;
    // per-request construction would reset the limiter each call and never trip.
    const ip = "198.51.100.20";
    let lastError: string | undefined;
    for (let i = 0; i < 12; i++) {
      const res = await call({ turnstile_token: turnstileToken() }, ip);
      if (res.status === 429) {
        lastError = ((await res.json()) as { error: string }).error;
        break;
      }
    }
    expect(lastError).toBe("too_many_requests");
  });

  it("shared-preview uses siteverify and rejects fixture-prefixed tokens before writes", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ success: false, "error-codes": ["invalid-input-response"] }),
    );
    vi.stubGlobal("fetch", fetcher);
    const beforeOrganizations = await rowCount("organizations");
    const beforeApps = await rowCount("apps");

    const res = await call(
      { turnstile_token: `${FIXTURE_TURNSTILE_TOKEN}-hosted` },
      "198.51.100.86",
      "/agent/identity",
      hostedEnvWith({
        SPLITCH_PLATFORM_TARGET: "shared-preview",
        ACCESS_TOKEN_SECRET: hostedAccessTokenSecret,
      }),
    );

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("access_denied");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(await rowCount("organizations")).toBe(beforeOrganizations);
    expect(await rowCount("apps")).toBe(beforeApps);
  });

  it.each(["shared-preview", "production"])(
    "%s fails closed without WORKOS_API_KEY instead of using fixture WorkOS",
    async (target) => {
      const beforeOrganizations = await rowCount("organizations");
      const { WORKOS_API_KEY: _missing, ...withoutWorkosKey } = hostedEnvWith({
        SPLITCH_PLATFORM_TARGET: target,
        WORKOS_CLIENT_ID: "workos-client",
      });
      const res = await call(
        { turnstile_token: turnstileToken() },
        `198.51.100.${target === "shared-preview" ? "90" : "91"}`,
        "/agent/identity",
        withoutWorkosKey,
      );

      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({ error: "server_error" });
      expect(await rowCount("organizations")).toBe(beforeOrganizations);
    },
  );

  it("hosted claims fail closed when the Control Panel origin is missing", async () => {
    const beforeOrganizations = await rowCount("organizations");
    const { CONTROL_PANEL_ORIGIN: _missing, ...withoutPanelOrigin } = hostedEnvWith({});
    const res = await call(
      { turnstile_token: turnstileToken() },
      "198.51.100.92",
      "/agent/identity",
      withoutPanelOrigin,
    );

    expect(res.status).toBe(500);
    expect(await rowCount("organizations")).toBe(beforeOrganizations);
  });

  it.each(["WORKOS_JWKS_URI", "WORKOS_ISSUER"] as const)(
    "hosted claims fail closed when %s is missing",
    async (missingBinding) => {
      const beforeOrganizations = await rowCount("organizations");
      const hostedEnv = hostedEnvWith({});
      delete hostedEnv[missingBinding];

      const res = await call(
        { turnstile_token: turnstileToken() },
        missingBinding === "WORKOS_JWKS_URI" ? "198.51.100.93" : "198.51.100.94",
        "/agent/identity",
        hostedEnv,
      );

      expect(res.status).toBe(500);
      expect(await rowCount("organizations")).toBe(beforeOrganizations);
    },
  );
});

function hostedEnvWith(overrides: Partial<AuthApiEnv>): AuthApiEnv {
  return {
    ...env,
    SPLITCH_PLATFORM_TARGET: "production",
    SPLITCH_DEPLOYED_COMMIT_SHA: "a".repeat(40),
    WORKOS_API_KEY: "test-workos-api-key",
    WORKOS_CLIENT_ID: "test-workos-client-id",
    WORKOS_JWKS_URI: "https://api.workos.test/jwks",
    WORKOS_ISSUER: "https://api.workos.test",
    TURNSTILE_SECRET: "test-turnstile-secret",
    ASSERTION_SIGNING_SECRET: hostedAssertionSigningSecret,
    ...overrides,
  };
}

/**
 * Production ran with a leftover HMAC ACCESS_TOKEN_SECRET: presence-only
 * validation booted a Worker that reported healthy and then threw on every mint,
 * so every door returned an opaque 500. Signability is config, so it has to fail
 * at config time.
 */
describe("index.ts: hosted ACCESS_TOKEN_SECRET signability is config, not a mint-time surprise", () => {
  /**
   * A hand-built JWK carrying only the fields a structural check looks at.
   * Workers WebCrypto accepts this abbreviated shape, so config validation must
   * explicitly require the CRT parameters emitted with a complete private JWK.
   */
  async function jwkWithoutCrtParams(): Promise<string> {
    const { kty, n, e, d } = JSON.parse(hostedAccessTokenSecret) as Record<string, string>;
    return JSON.stringify({ kty, n, e, d });
  }

  it.each([
    ["an opaque string", async () => "leftover-hmac-secret"],
    ["a JWK missing its CRT parameters", jwkWithoutCrtParams],
  ])("rejects %s on health as well as on the doors", async (_label, makeSecret) => {
    const hostedEnv = hostedEnvWith({ ACCESS_TOKEN_SECRET: await makeSecret() });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    // Health too: an operator reaches for it first, and it must not report a
    // Worker healthy when that Worker cannot sign a single token.
    for (const path of ["/health", "/agent/identity"]) {
      const res = await call(
        { turnstile_token: turnstileToken() },
        "198.51.100.95",
        path,
        hostedEnv,
      );
      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({
        error: "server_error",
        error_description: "ACCESS_TOKEN_SECRET is not a usable RS256 signing key",
      });
    }
    expect(logged).toHaveBeenCalled();
  });

  it("accepts an RSA private JWK and serves its public half at the JWKS route", async () => {
    const request = new Request("https://auth.splitch.test/.well-known/jwks.json");
    const res = await worker.fetch(
      request as unknown as Parameters<typeof worker.fetch>[0],
      hostedEnvWith({ ACCESS_TOKEN_SECRET: hostedAccessTokenSecret }),
      testCtx,
    );

    expect(res.status).toBe(200);
    const { keys } = (await res.json()) as { keys: Array<{ kty: string; alg: string }> };
    expect(keys[0]).toMatchObject({ kty: "RSA", alg: "RS256" });
  });
});

describe("index.ts: hosted assertion secret and platform target fail closed", () => {
  it.each(["shared-preview", "production"] as const)(
    "%s refuses a missing ASSERTION_SIGNING_SECRET before serving a door",
    async (target) => {
      const { ASSERTION_SIGNING_SECRET: _missing, ...withoutSecret } = hostedEnvWith({
        SPLITCH_PLATFORM_TARGET: target,
        ACCESS_TOKEN_SECRET: hostedAccessTokenSecret,
      });
      const beforeOrganizations = await rowCount("organizations");
      const res = await call(
        { turnstile_token: turnstileToken() },
        target === "shared-preview" ? "198.51.100.96" : "198.51.100.97",
        "/agent/identity",
        withoutSecret,
      );
      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({ error: "server_error" });
      expect(await rowCount("organizations")).toBe(beforeOrganizations);
    },
  );

  it.each(committedAssertionSigningSecrets)(
    "rejects committed assertion secret %s on hosted targets",
    async (secret) => {
      const beforeOrganizations = await rowCount("organizations");
      const res = await call(
        { turnstile_token: turnstileToken() },
        "198.51.100.98",
        "/agent/identity",
        hostedEnvWith({
          ACCESS_TOKEN_SECRET: hostedAccessTokenSecret,
          ASSERTION_SIGNING_SECRET: secret,
        }),
      );
      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({ error: "server_error" });
      expect(await rowCount("organizations")).toBe(beforeOrganizations);
    },
  );

  it("does not treat an unset platform target as local", async () => {
    const { SPLITCH_PLATFORM_TARGET: _missing, ...withoutTarget } = env;
    const beforeOrganizations = await rowCount("organizations");
    const res = await call(
      { turnstile_token: turnstileToken() },
      "198.51.100.99",
      "/agent/identity",
      withoutTarget,
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "server_error" });
    expect(await rowCount("organizations")).toBe(beforeOrganizations);
  });

  it.each(["local", "pr-ci"] as const)(
    "%s still accepts the committed local assertion secret",
    async (target) => {
      const { ASSERTION_SIGNING_SECRET: _defaultSecret, ...localEnv } = env;
      const res = await call(
        { turnstile_token: turnstileToken() },
        target === "local" ? "198.51.100.100" : "198.51.100.101",
        "/agent/identity",
        { ...localEnv, SPLITCH_PLATFORM_TARGET: target },
      );
      expect(res.status).toBe(200);
    },
  );
});
