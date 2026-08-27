import type { Principal } from "@splitch/worker-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  EVALUATION_RATE_LIMIT_BINDING_LIMIT,
  EVALUATION_RATE_LIMIT_RETRY_AFTER_MS,
  evaluationRateLimitIncrement,
  makeEvaluationRateLimiter,
  rememberCredentialRateLimitRps,
} from "./evaluation-rate-limit";
import { CLIENT_KEY, makeSdkRouteHarness, sdkRouteInit } from "./sdk-route-test-fixtures";

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

  it("returns typed RATE_LIMITED when evaluate traffic exceeds an exact 30 rps cap", async () => {
    const tokens = { remaining: evaluationRateLimitIncrement(30) };
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

    expect((await app.request("/api/sdk/evaluate", sdkRouteInit(CLIENT_KEY))).status).toBe(200);
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
