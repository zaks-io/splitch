import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthApiEnv } from "./env";
import worker from "./index";
import { FIXTURE_OTP } from "./otp";
import { makePoolBindings } from "./test-bindings-pool";
import type { LocalBindings } from "./test-fixtures";
import { FIXTURE_TURNSTILE_TOKEN } from "./turnstile";

const MCP_RESOURCE = "https://mcp.splitch.test/mcp";
let local: LocalBindings;
let env: AuthApiEnv;
let disposeLocal: (() => void) | undefined;

beforeAll(async () => {
  local = await makePoolBindings();
  disposeLocal = local.dispose;
  env = {
    DB: local.d1,
    JTI_CACHE: local.kv,
    SESSION_STORE: local.sessionKv,
    AUTH_API_ORIGIN: "https://auth.splitch.test",
    CONTROL_PLANE_ORIGIN: "https://cp.splitch.test",
    MCP_ORIGIN: "https://mcp.splitch.test",
    CONTROL_PANEL_ORIGIN: "https://app.splitch.test",
    SPLITCH_PLATFORM_TARGET: "local",
    ASSERTION_SIGNING_SECRET: "test-assertion-secret",
  };
});

afterAll(() => disposeLocal?.());

const testCtx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

describe("Door B claim to MCP", () => {
  it("keeps the selected MCP resource through claim and idempotent replay", async () => {
    const registration = await authJson("/agent/identity", {
      turnstile_token: `${FIXTURE_TURNSTILE_TOKEN}-claim-mcp`,
    });
    expect(registration.status).toBe(200);
    const identity = (await registration.json()) as { identity_assertion: string };
    const baseClaim = {
      identity_assertion: identity.identity_assertion,
      email: "mcp-claim@example.com",
    };
    expect(
      (await authJson("/agent/identity/claim", { ...baseClaim, resource: MCP_RESOURCE })).status,
    ).toBe(200);

    const claim = (extra: Record<string, string>) =>
      authJson("/agent/identity/claim", {
        ...baseClaim,
        otp: FIXTURE_OTP,
        idempotency_key: "claim-mcp-resource",
        ...extra,
      });
    const first = await claim({ resource: MCP_RESOURCE });
    const replay = await claim({});
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);

    const verifier = await mcpVerifier();
    for (const response of [first, replay]) {
      const token = ((await response.json()) as { access_token: string }).access_token;
      await expect(
        verifier.verify(`Bearer ${token}`, MCP_RESOURCE, nowSeconds()),
      ).resolves.toMatchObject({
        subject: expect.any(String),
      });
      await expect(
        verifier.verify(`Bearer ${token}`, "https://cp.splitch.test", nowSeconds()),
      ).resolves.toBeNull();
    }

    const widened = await claim({ resource: "https://cp.splitch.test" });
    expect(widened.status).toBe(400);
    expect(await widened.json()).toMatchObject({ error: "invalid_request" });
  });
});

function authJson(path: string, body: Record<string, string>): Promise<Response> {
  return Promise.resolve(
    worker.fetch(
      new Request(`https://auth.splitch.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }) as unknown as Parameters<typeof worker.fetch>[0],
      env,
      testCtx,
    ),
  );
}

async function mcpVerifier() {
  const module = (await import(
    new URL("../../mcp-server/src/mcp-access-token.ts", import.meta.url).href
  )) as {
    makeHttpMcpAccessTokenVerifier(options: {
      issuer: string;
      fetchJwks: () => Promise<{ keys: JsonWebKey[] }>;
    }): {
      verify(
        authorization: string,
        audience: string,
        now: number,
      ): Promise<{ subject: string } | null>;
    };
  };
  return module.makeHttpMcpAccessTokenVerifier({
    issuer: "https://auth.splitch.test",
    fetchJwks: async () => {
      const response = await worker.fetch(
        new Request("https://auth.splitch.test/.well-known/jwks.json") as unknown as Parameters<
          typeof worker.fetch
        >[0],
        env,
        testCtx,
      );
      expect(response.headers.get("cache-control")).toBe("public, max-age=300");
      return (await response.json()) as { keys: JsonWebKey[] };
    },
  });
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
