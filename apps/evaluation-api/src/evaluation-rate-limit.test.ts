import { getRoute } from "@splitch/contracts";
import type { Principal } from "@splitch/worker-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  EVALUATION_RATE_LIMIT_BINDING_LIMIT,
  EVALUATION_RATE_LIMIT_PERIOD_SECONDS,
  EVALUATION_RATE_LIMIT_RETRY_AFTER_MS,
  evaluationRateLimitIncrement,
  evaluationRateLimitKey,
  makeEvaluationRateLimiter,
  rememberCredentialRateLimitRps,
} from "./evaluation-rate-limit";
import {
  API_KEY,
  CLIENT_KEY,
  makeSdkRouteHarness,
  sdkRouteInit,
  sha256Hex,
} from "./sdk-route-test-fixtures";

describe("evaluationRateLimitIncrement", () => {
  it("matches the Cloudflare binding's 100 rps window", () => {
    expect(EVALUATION_RATE_LIMIT_BINDING_LIMIT / EVALUATION_RATE_LIMIT_PERIOD_SECONDS).toBe(100);
  });

  it("consumes one token at the ADR 100 rps default", () => {
    expect(evaluationRateLimitIncrement(100)).toBe(1);
  });

  it("consumes more tokens for a tighter override", () => {
    expect(evaluationRateLimitIncrement(25)).toBe(4);
    expect(evaluationRateLimitIncrement(50)).toBe(2);
  });

  it("never spends fewer tokens than the stored cap allows", () => {
    expect(evaluationRateLimitIncrement(80)).toBe(2);
    expect(evaluationRateLimitIncrement(67)).toBe(2);
  });
});

describe("makeEvaluationRateLimiter", () => {
  it("fails closed when the Cloudflare binding is missing", async () => {
    await expect(makeEvaluationRateLimiter(undefined)(input())).rejects.toThrow(
      "evaluation-api: evaluation rate-limit binding is not configured",
    );
  });

  it("fails closed when credential rate-limit state was not recorded", async () => {
    const limit = vi.fn(async () => ({ success: true }));
    await expect(makeEvaluationRateLimiter({ limit })(input())).rejects.toThrow(
      "evaluation-api: credential rate-limit state is missing",
    );
    expect(limit).not.toHaveBeenCalled();
  });

  it("fails closed when the principal id is not a credential hash", async () => {
    const limit = vi.fn(async () => ({ success: true }));
    const request = new Request("https://edge.test/api/sdk/evaluate");
    rememberCredentialRateLimitRps(request, 100);
    await expect(
      makeEvaluationRateLimiter({ limit })(
        input({
          request,
          principal: principal({ id: "client_key:not-a-hash" }),
        }),
      ),
    ).rejects.toThrow("evaluation-api: rate limiter missing credential hash");
    expect(limit).not.toHaveBeenCalled();
  });

  it("propagates binding failures so the runtime fails closed", async () => {
    const request = new Request("https://edge.test/api/sdk/evaluate");
    rememberCredentialRateLimitRps(request, 100);
    const limit = vi.fn(async () => {
      throw new Error("binding unavailable");
    });

    await expect(makeEvaluationRateLimiter({ limit })(input({ request }))).rejects.toThrow(
      "binding unavailable",
    );
  });

  it("keys counters by credential hash and route class, never the raw credential", async () => {
    const request = new Request("https://edge.test/api/sdk/evaluate");
    rememberCredentialRateLimitRps(request, null);
    const hash = "a".repeat(64);
    const limit = vi.fn(async () => ({ success: true }));

    await expect(
      makeEvaluationRateLimiter({ limit })(
        input({ request, principal: principal({ id: `client_key:${hash}` }) }),
      ),
    ).resolves.toEqual({ limited: false });

    expect(limit).toHaveBeenCalledWith({ key: `${hash}:client-key` });
    expect(JSON.stringify(limit.mock.calls)).not.toContain("pk_");
    expect(evaluationRateLimitKey(principal({ id: `client_key:${hash}` }), "client-key")).toBe(
      `${hash}:client-key`,
    );
  });

  it("keeps distinct credentials on distinct counters", async () => {
    const first = new Request("https://edge.test/api/sdk/evaluate");
    const second = new Request("https://edge.test/api/sdk/evaluate");
    rememberCredentialRateLimitRps(first, 100);
    rememberCredentialRateLimitRps(second, 100);
    const limit = vi.fn(async () => ({ success: true }));
    const limiter = makeEvaluationRateLimiter({ limit });
    const firstHash = "b".repeat(64);
    const secondHash = "c".repeat(64);

    await limiter(
      input({ request: first, principal: principal({ id: `client_key:${firstHash}` }) }),
    );
    await limiter(
      input({
        request: second,
        principal: principal({ id: `api_key:${secondHash}` }),
        class: "api-key",
      }),
    );

    expect(limit).toHaveBeenNthCalledWith(1, { key: `${firstHash}:client-key` });
    expect(limit).toHaveBeenNthCalledWith(2, { key: `${secondHash}:api-key` });
  });

  it("honors an explicit tighter override by debiting more official limit() calls", async () => {
    const request = new Request("https://edge.test/api/sdk/evaluate");
    rememberCredentialRateLimitRps(request, 25);
    const limit = vi.fn(async () => ({ success: true }));

    await makeEvaluationRateLimiter({ limit })(input({ request }));

    expect(limit).toHaveBeenCalledTimes(4);
    expect(limit).toHaveBeenCalledWith({ key: `${"a".repeat(64)}:client-key` });
  });

  it("fails closed when a later debit in a tighter override is denied", async () => {
    const request = new Request("https://edge.test/api/sdk/evaluate");
    rememberCredentialRateLimitRps(request, 25);
    const limit = vi
      .fn()
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false });

    await expect(makeEvaluationRateLimiter({ limit })(input({ request }))).resolves.toEqual({
      limited: true,
      retryAfterMs: EVALUATION_RATE_LIMIT_RETRY_AFTER_MS,
    });
    expect(limit).toHaveBeenCalledTimes(2);
  });

  it("returns a bounded retry window when the credential is limited", async () => {
    const request = new Request("https://edge.test/api/sdk/evaluate");
    rememberCredentialRateLimitRps(request, 100);
    const limit = vi.fn(async () => ({ success: false }));

    await expect(makeEvaluationRateLimiter({ limit })(input({ request }))).resolves.toEqual({
      limited: true,
      retryAfterMs: EVALUATION_RATE_LIMIT_RETRY_AFTER_MS,
    });
  });

  it("inherits a control-plane-actor class instead of throwing", async () => {
    const limit = vi.fn(async () => ({ success: true }));
    await expect(
      makeEvaluationRateLimiter({ limit })(input({ class: "control-plane-actor" })),
    ).resolves.toEqual({ limited: false });
    expect(limit).not.toHaveBeenCalled();
  });

  it("still fails closed on an unknown guarded class", async () => {
    await expect(
      makeEvaluationRateLimiter({ limit: vi.fn() })(input({ class: "anonymous-registration" })),
    ).rejects.toThrow("evaluation-api: unsupported rate-limit class anonymous-registration");
  });
});

describe("evaluation rate limiter on the public evaluate route", () => {
  it("returns typed RATE_LIMITED with retry timing when the binding denies", async () => {
    const route = getRoute("sdk_evaluate");
    if (!route) throw new Error("sdk_evaluate is not registered");
    const { app } = await makeSdkRouteHarness({
      liveRun: true,
      rateLimiter: makeEvaluationRateLimiter({
        limit: async () => ({ success: false }),
      }),
    });

    const response = await app.request("/api/sdk/evaluate", sdkRouteInit(CLIENT_KEY));
    const body = (await response.json()) as {
      code: string;
      details: { retryAfterMs: number };
    };

    expect(response.status).toBe(429);
    expect(body).toMatchObject({
      code: "RATE_LIMITED",
      details: { retryAfterMs: EVALUATION_RATE_LIMIT_RETRY_AFTER_MS },
    });
    expect(response.headers.get("retry-after")).toBe(
      String(Math.ceil(EVALUATION_RATE_LIMIT_RETRY_AFTER_MS / 1000)),
    );
    expect(JSON.stringify(body)).not.toContain(CLIENT_KEY);
  });

  it("fails closed when the binding throws on a guarded evaluate", async () => {
    const { app } = await makeSdkRouteHarness({
      liveRun: true,
      rateLimiter: makeEvaluationRateLimiter({
        limit: async () => {
          throw new Error("binding unavailable");
        },
      }),
    });

    const response = await app.request("/api/sdk/evaluate", sdkRouteInit(CLIENT_KEY));
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("fails closed when the binding is missing on a guarded evaluate", async () => {
    const { app } = await makeSdkRouteHarness({
      liveRun: true,
      rateLimiter: makeEvaluationRateLimiter(undefined),
    });

    const response = await app.request("/api/sdk/evaluate", sdkRouteInit(CLIENT_KEY));
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("honors an explicit cache override on the mounted evaluate route", async () => {
    const limit = vi.fn(async () => ({ success: true }));
    const { app } = await makeSdkRouteHarness({
      liveRun: true,
      clientKeyRateLimitRps: 25,
      rateLimiter: makeEvaluationRateLimiter({ limit }),
    });

    expect((await app.request("/api/sdk/evaluate", sdkRouteInit(CLIENT_KEY))).status).toBe(200);
    expect(limit).toHaveBeenCalledTimes(4);
    expect(limit).toHaveBeenCalledWith({
      key: `${await sha256Hex(CLIENT_KEY)}:client-key`,
    });
  });

  it("keeps distinct credentials on distinct counters across mounted routes", async () => {
    const limit = vi.fn(async () => ({ success: true }));
    const { app } = await makeSdkRouteHarness({
      liveRun: true,
      rateLimiter: makeEvaluationRateLimiter({ limit }),
    });

    expect((await app.request("/api/sdk/evaluate", sdkRouteInit(CLIENT_KEY))).status).toBe(200);
    expect((await app.request("/api/sdk/peek", sdkRouteInit(API_KEY))).status).toBe(200);

    expect(limit).toHaveBeenCalledWith({
      key: `${await sha256Hex(CLIENT_KEY)}:client-key`,
    });
    expect(limit).toHaveBeenCalledWith({
      key: `${await sha256Hex(API_KEY)}:api-key`,
    });
  });

  it("uses the presented credential hash, not the raw Client Key, as the counter key", async () => {
    const hash = await sha256Hex(CLIENT_KEY);
    const limit = vi.fn(async () => ({ success: true }));
    const { app } = await makeSdkRouteHarness({
      liveRun: true,
      rateLimiter: makeEvaluationRateLimiter({ limit }),
    });

    const response = await app.request("/api/sdk/evaluate", sdkRouteInit(CLIENT_KEY));
    expect(response.status).toBe(200);
    expect(limit).toHaveBeenCalledWith({ key: `${hash}:client-key` });
    expect(JSON.stringify(limit.mock.calls)).not.toContain(CLIENT_KEY);
  });
});

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    kind: "client-key",
    id: `client_key:${"a".repeat(64)}`,
    scopes: ["data-plane:evaluate"],
    orgId: "org_1",
    appId: "app_1",
    environmentId: "env_1",
    authDoor: null,
    ...overrides,
  };
}

function input(
  overrides: Partial<{
    class: "client-key" | "api-key" | "control-plane-actor" | "anonymous-registration";
    request: Request;
    principal: Principal;
  }> = {},
) {
  return {
    class: "client-key" as const,
    request: new Request("https://edge.test/api/sdk/evaluate"),
    principal: principal(),
    ...overrides,
  };
}
