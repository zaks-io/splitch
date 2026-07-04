import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthApiEnv } from "./env";
import worker from "./index";
import { FIXTURE_OTP } from "./otp";
import { type LocalBindings, makeLocalBindings } from "./test-fixtures";
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

beforeAll(async () => {
  local = await makeLocalBindings();
  env = {
    DB: local.d1,
    JTI_CACHE: local.kv,
    SESSION_STORE: local.sessionKv,
    AUTH_API_ORIGIN: "https://auth.splitch.test",
    CONTROL_PLANE_ORIGIN: "https://cp.splitch.test",
    ASSERTION_SIGNING_SECRET: "test-assertion-secret",
    ACCESS_TOKEN_SECRET: "test-access-secret",
  };
});

afterAll(() => local.dispose());

function call(body: unknown, ip: string, path = "/agent/identity"): Promise<Response> {
  const request = new Request(`https://auth.splitch.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify(body),
  });
  // The handler's typed param is the Cloudflare IncomingRequest (carries `cf`);
  // a plain test Request lacks those edge-only props, so cast at the boundary —
  // the handler reads only headers/url/body, never `cf`.
  return worker.fetch(request as unknown as Parameters<typeof worker.fetch>[0], env);
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
});
