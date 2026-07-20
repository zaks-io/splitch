import { MCP_DELEGATION_HEADER } from "@splitch/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthApiEnv } from "./env";
import worker from "./index";
import { makeKvRevocationStore } from "./revocation";
import { type LocalBindings, makeLocalBindings } from "./test-fixtures";

let local: LocalBindings;
let env: AuthApiEnv;
let disposeLocal: (() => void) | undefined;

const DEVICE_USER = "user_device_fixture";
const SELECTED_ORG = "org_selected";
const SELECTED_APP = "app_selected";
const VICTIM_APP = "app_victim";
const NOW_ISO = "2026-07-20T00:00:00.000Z";

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
  await seedMemberships();
});

afterAll(() => disposeLocal?.());

const testCtx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

describe("local Auth-to-MCP integration", () => {
  it("derives device authority from live memberships and rejects a requested victim App scope", async () => {
    const accessTokenModule = (await import(
      new URL("../../mcp-server/src/mcp-access-token.ts", import.meta.url).href
    )) as McpAccessTokenModule;
    const handlerModule = (await import(
      new URL("../../mcp-server/src/mcp-handler.ts", import.meta.url).href
    )) as McpHandlerModule;
    const authorization = await authFetch(
      new Request("https://auth.splitch.test/oauth2/device_authorization", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ scope: `app:${SELECTED_APP}:owner` }),
      }),
    );
    expect(authorization.status).toBe(200);
    const deviceCode = ((await authorization.json()) as { device_code: string }).device_code;
    const widenedToken = await authFetch(
      new Request("https://auth.splitch.test/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
          scope: `app:${VICTIM_APP}:owner`,
          resource: "https://mcp.splitch.test/mcp",
        }),
      }),
    );
    expect(widenedToken.status).toBe(400);
    expect(await widenedToken.json()).toMatchObject({ error: "invalid_grant" });
    const tokenResponse = await authFetch(
      new Request("https://auth.splitch.test/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
          scope: `app:${SELECTED_APP}:owner`,
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
    await expect(
      verifier.verify(
        `Bearer ${accessToken}`,
        "https://mcp.splitch.test/mcp",
        Math.floor(Date.now() / 1000),
      ),
    ).resolves.toEqual({ subject: DEVICE_USER, scopes: [`app:${SELECTED_APP}:admin`] });
    const accepted = await mcpRequest(
      handlerModule.handleMcpServerRequest,
      accessToken,
      verifier,
      revocations,
      "tools/list",
    );
    expect(accepted.status).toBe(200);

    const victimScope = `app:${VICTIM_APP}:admin`;
    const victimDelegations: string[][] = [];
    const victimDownstream = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const scopes = decodeDelegationScopes(request);
      victimDelegations.push(scopes);
      if (scopes.includes(victimScope)) {
        return Response.json({ items: [], cursor: null, limit: 50, total: null });
      }
      return Response.json(
        { code: "FORBIDDEN", message: "credential is not scoped to this app", details: {} },
        { status: 403 },
      );
    });
    const victimUse = await mcpRequest(
      handlerModule.handleMcpServerRequest,
      accessToken,
      verifier,
      revocations,
      "tools/call",
      { name: "flags_list", arguments: { appId: VICTIM_APP } },
      victimDownstream,
    );
    const victimBody = (await victimUse.json()) as {
      result: { isError?: boolean; structuredContent?: { code?: string } };
    };
    expect(victimBody.result).toMatchObject({
      isError: true,
      structuredContent: { code: "FORBIDDEN" },
    });
    expect(victimDelegations).toEqual([[]]);

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

async function seedMemberships(): Promise<void> {
  await local.d1
    .prepare(
      "INSERT INTO organizations (id, name, plan, created_at, updated_at) VALUES (?,?,?,?,?)",
    )
    .bind(SELECTED_ORG, "Selected Org", "free", NOW_ISO, NOW_ISO)
    .run();
  await local.d1
    .prepare("INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES (?,?,?,?)")
    .bind(SELECTED_ORG, DEVICE_USER, "owner", NOW_ISO)
    .run();
  for (const [appId, key] of [
    [SELECTED_APP, "selected"],
    [VICTIM_APP, "victim"],
  ]) {
    await local.d1
      .prepare(
        "INSERT INTO apps (id, organization_id, name, key, created_at, updated_at, created_by) VALUES (?,?,?,?,?,?,?)",
      )
      .bind(appId, SELECTED_ORG, key, key, NOW_ISO, NOW_ISO, DEVICE_USER)
      .run();
  }
  await local.d1
    .prepare("INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES (?,?,?,?)")
    .bind(SELECTED_APP, DEVICE_USER, "admin", NOW_ISO)
    .run();
  await local.d1
    .prepare("INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES (?,?,?,?)")
    .bind(VICTIM_APP, DEVICE_USER, "admin", NOW_ISO)
    .run();
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

function decodeDelegationScopes(request: Request): string[] {
  const delegation = request.headers.get(MCP_DELEGATION_HEADER);
  if (!delegation) return [];
  const payload = delegation.split(".")[0];
  if (!payload) throw new Error("missing MCP delegation payload");
  const padded = payload
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(payload.length / 4) * 4, "=");
  const claims = JSON.parse(atob(padded)) as { scopes?: unknown };
  if (!Array.isArray(claims.scopes)) throw new Error("missing MCP delegation scopes");
  return claims.scopes as string[];
}
