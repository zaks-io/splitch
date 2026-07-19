import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthApiEnv } from "./env";
import worker from "./index";
import { makeKvRevocationStore } from "./revocation";
import { type LocalBindings, makeLocalBindings } from "./test-fixtures";

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
    AUTH_API_ORIGIN: "https://auth.splitch.test",
    CONTROL_PLANE_ORIGIN: "https://cp.splitch.test",
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

describe("local Auth-to-MCP integration", () => {
  it("accepts a real local RS256 token until Auth revokes it", async () => {
    const accessTokenModule = (await import(
      new URL("../../mcp-server/src/mcp-access-token.ts", import.meta.url).href
    )) as McpAccessTokenModule;
    const handlerModule = (await import(
      new URL("../../mcp-server/src/mcp-handler.ts", import.meta.url).href
    )) as McpHandlerModule;
    const tokenResponse = await authFetch(
      new Request("https://auth.splitch.test/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: "fixture-approved-device-code",
          scope: [
            "app:app_selected:admin",
            "app:app_unrelated:owner",
            "org:org_unrelated:owner",
          ].join(" "),
          resource: "https://mcp.splitch.test/mcp",
        }),
      }),
    );
    expect(tokenResponse.status).toBe(200);
    const accessToken = ((await tokenResponse.json()) as { access_token: string }).access_token;
    expect(decodeJwtHeader(accessToken)).toMatchObject({ alg: "RS256" });

    const verifier = accessTokenModule.makeHttpMcpAccessTokenVerifier({
      issuer: "https://auth.splitch.test",
      fetchJwks: async () => {
        const response = await authFetch(
          new Request("https://auth.splitch.test/.well-known/jwks.json"),
        );
        expect(response.status).toBe(200);
        return (await response.json()) as {
          keys: Array<{ kty: string; kid?: string; n?: string; e?: string }>;
        };
      },
    });
    const revocations = makeKvRevocationStore(local.sessionKv);
    const accepted = await mcpRequest(
      handlerModule.handleMcpServerRequest,
      accessToken,
      verifier,
      revocations,
      "tools/list",
    );
    expect(accepted.status).toBe(200);

    const revoked = await authFetch(
      new Request("https://auth.splitch.test/oauth2/revoke", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: accessToken }),
      }),
    );
    expect(revoked.status).toBe(200);

    const downstream = vi.fn(async () => Response.json({ items: [] }));
    const rejected = await mcpRequest(
      handlerModule.handleMcpServerRequest,
      accessToken,
      verifier,
      revocations,
      "tools/call",
      { name: "flags_list", arguments: { appId: "app_selected" } },
      downstream,
    );
    expect(rejected.status).toBe(401);
    expect(downstream).not.toHaveBeenCalled();
  });
});

function authFetch(request: Request): Promise<Response> {
  return Promise.resolve(
    worker.fetch(request as unknown as Parameters<typeof worker.fetch>[0], env, testCtx),
  );
}

function mcpRequest(
  handleMcpServerRequest: McpHandlerModule["handleMcpServerRequest"],
  token: string,
  tokenVerifier: McpAccessTokenVerifier,
  revocations: ReturnType<typeof makeKvRevocationStore>,
  method: string,
  params?: unknown,
  controlPlaneFetch?: typeof fetch,
): Promise<Response> {
  return handleMcpServerRequest({
    request: new Request("https://mcp.splitch.test/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    service: "splitch-mcp-server",
    platformTarget: "local",
    tokenVerifier,
    revocations,
    controlPlaneFetch,
    controlPlaneDelegationSecret: "local-mcp-control-plane-delegation-secret",
    evaluationDelegationSecret: "local-mcp-evaluation-delegation-secret",
    analysisDelegationSecret: "local-mcp-analysis-delegation-secret",
  });
}

interface McpAccessTokenVerifier {
  verify(
    authorization: string | null,
    expectedAudience: string,
    nowSeconds: number,
  ): Promise<{ subject: string; scopes: string[] } | null>;
}

interface McpAccessTokenModule {
  makeHttpMcpAccessTokenVerifier(options: {
    issuer: string;
    fetchJwks: () => Promise<{
      keys: Array<{ kty: string; kid?: string; n?: string; e?: string }>;
    }>;
  }): McpAccessTokenVerifier;
}

interface McpHandlerModule {
  handleMcpServerRequest(options: {
    request: Request;
    service: string;
    platformTarget: string;
    tokenVerifier: McpAccessTokenVerifier;
    revocations: ReturnType<typeof makeKvRevocationStore>;
    controlPlaneFetch?: typeof fetch;
    controlPlaneDelegationSecret: string;
    evaluationDelegationSecret: string;
    analysisDelegationSecret: string;
  }): Promise<Response>;
}

function decodeJwtHeader(token: string): Record<string, unknown> {
  const [header] = token.split(".");
  if (!header) throw new Error("missing JWT header");
  const padded = header
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(header.length / 4) * 4, "=");
  return JSON.parse(atob(padded)) as Record<string, unknown>;
}
