import { CURRENT_KV_SCHEMA_VERSION, clientKeyCacheKey } from "@splitch/contracts";
import type { Principal } from "@splitch/worker-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  EVALUATION_RATE_LIMIT_BINDING_LIMIT,
  EVALUATION_RATE_LIMIT_RETRY_AFTER_MS,
  evaluationRateLimitIncrement,
  makeEvaluationRateLimiter,
  rememberCredentialRateLimitRps,
} from "./evaluation-rate-limit";
import {
  APP_ID,
  CLIENT_KEY,
  ENVIRONMENT_ID,
  makeSdkRouteHarness,
  sdkRouteInit,
  sha256Hex,
} from "./sdk-route-test-fixtures";

describe("exact 30 rps Client Key override", () => {
  it("RATE_LIMITED with retry timing after the exact 30 rps window is exhausted", async () => {
    const tokens = { remaining: EVALUATION_RATE_LIMIT_BINDING_LIMIT };
    const limit = vi.fn(async () => {
      if (tokens.remaining <= 0) {
        return { success: false };
      }
      tokens.remaining -= 1;
      return { success: true };
    });
    const limiter = makeEvaluationRateLimiter({ limit });
    const allowedRequests = EVALUATION_RATE_LIMIT_BINDING_LIMIT / evaluationRateLimitIncrement(30);

    for (let i = 0; i < allowedRequests; i += 1) {
      const request = new Request("https://edge.test/api/sdk/evaluate");
      rememberCredentialRateLimitRps(request, 30);
      await expect(limiter(input({ request }))).resolves.toEqual({ limited: false });
    }

    const over = new Request("https://edge.test/api/sdk/evaluate");
    rememberCredentialRateLimitRps(over, 30);
    await expect(limiter(input({ request: over }))).resolves.toEqual({
      limited: true,
      retryAfterMs: EVALUATION_RATE_LIMIT_RETRY_AFTER_MS,
    });
    expect(allowedRequests).toBe(300);
  });

  it("PATCH-to-evaluate: 300 requests at a persisted 30 rps then typed RATE_LIMITED", async () => {
    const tokens = { remaining: EVALUATION_RATE_LIMIT_BINDING_LIMIT };
    const { app } = await makeSdkRouteHarness({
      liveRun: true,
      clientKeyRateLimitRps: 30,
      rateLimiter: makeEvaluationRateLimiter({
        limit: async () => {
          if (tokens.remaining <= 0) {
            return { success: false };
          }
          tokens.remaining -= 1;
          return { success: true };
        },
      }),
    });

    for (let i = 0; i < 300; i += 1) {
      expect((await app.request("/api/sdk/evaluate", sdkRouteInit(CLIENT_KEY))).status).toBe(200);
    }

    const limited = await app.request("/api/sdk/evaluate", sdkRouteInit(CLIENT_KEY));
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toMatchObject({
      code: "RATE_LIMITED",
      details: { retryAfterMs: EVALUATION_RATE_LIMIT_RETRY_AFTER_MS },
    });
    expect(limited.headers.get("retry-after")).toBe(
      String(Math.ceil(EVALUATION_RATE_LIMIT_RETRY_AFTER_MS / 1000)),
    );
  });

  it("maps a non-exact remembered override to a limiter fault, not an auth throw", async () => {
    const request = new Request("https://edge.test/api/sdk/evaluate");
    rememberCredentialRateLimitRps(request, 0);
    await expect(
      makeEvaluationRateLimiter({ limit: async () => ({ success: true }) })(input({ request })),
    ).rejects.toThrow(/positive integer/);
  });

  it("legacy raw cache 80 fail-closes as typed RATE_LIMITED on mounted evaluate", async () => {
    const { app, credentialKv } = await makeSdkRouteHarness({
      liveRun: true,
      rateLimiter: makeEvaluationRateLimiter({
        limit: async () => ({ success: true }),
      }),
    });
    credentialKv.putRaw(
      clientKeyCacheKey(await sha256Hex(CLIENT_KEY)),
      JSON.stringify({
        schemaVersion: CURRENT_KV_SCHEMA_VERSION,
        data: {
          appId: APP_ID,
          environmentId: ENVIRONMENT_ID,
          credentialSchemaVersion: 2,
          organizationId: "org_verify",
          kind: "client_key",
          scopes: ["data-plane:evaluate", "data-plane:write"],
          originAllowlist: null,
          rateLimitRps: 80,
          revoked: false,
          cachedAt: "2026-07-02T00:00:00.000Z",
        },
      }),
    );

    const limited = await app.request("/api/sdk/evaluate", sdkRouteInit(CLIENT_KEY));
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toMatchObject({ code: "RATE_LIMITED" });
  });
});

function principal(): Principal {
  return {
    kind: "client-key",
    id: `client_key:${"a".repeat(64)}`,
    scopes: ["data-plane:evaluate"],
    orgId: "org_1",
    appId: "app_1",
    environmentId: "env_1",
    authDoor: null,
  };
}

function input(overrides: { request: Request }) {
  return {
    class: "client-key" as const,
    principal: principal(),
    ...overrides,
  };
}
