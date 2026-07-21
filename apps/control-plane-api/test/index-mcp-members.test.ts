import { env } from "cloudflare:workers";
import { createMcpDelegationHeader, MCP_DELEGATION_HEADER } from "@splitch/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import type { ControlPlaneApiEnv } from "../src/env.js";
import worker, { McpEntrypoint } from "../src/index.js";

const AUDIENCE = "https://cp.splitch.test";
const MCP_DELEGATION_SECRET = "d".repeat(32);
const OWNER = "user_index_owner_1c91";
const ORG = {
  orgId: "org_index_members_241b",
  appId: "app_index_members_241b",
};

const testCtx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

let testEnv: ControlPlaneApiEnv;

beforeAll(async () => {
  await seedOrgApp(env.DB);
  testEnv = {
    ...env,
    CONTROL_PLANE_ORIGIN: AUDIENCE,
    MCP_CONTROL_PLANE_DELEGATION_SECRET: MCP_DELEGATION_SECRET,
  } as ControlPlaneApiEnv;
});

describe("index.ts: MCP service-binding boundary", () => {
  it("dispatches the local MCP fleet through the real named entrypoint", async () => {
    const mcpModule = (await import(
      new URL("../../mcp-server/src/mcp-handler.ts", import.meta.url).href
    )) as {
      handleMcpServerRequest(options: Record<string, unknown>): Promise<Response>;
    };
    const entrypoint = new McpEntrypoint(testCtx, testEnv);
    const response = await mcpModule.handleMcpServerRequest({
      request: new Request("https://mcp.local/mcp", {
        method: "POST",
        headers: { authorization: "Bearer local-mcp-token", "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "flags_list", arguments: { appId: ORG.appId } },
        }),
      }),
      service: "splitch-mcp-server",
      platformTarget: "local",
      tokenVerifier: {
        verify: async () => ({
          subject: OWNER,
          scopes: [`app:${ORG.appId}:admin`, "app:app_unrelated:owner", "org:org_unrelated:owner"],
        }),
      },
      revocations: { isRevoked: async () => false },
      controlPlaneFetch: (request: RequestInfo | URL, init?: RequestInit) =>
        entrypoint.fetch(request instanceof Request ? request : new Request(request, init)),
      controlPlaneDelegationSecret: MCP_DELEGATION_SECRET,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: { structuredContent: { items: [] } },
    });
  });

  it("rejects delegation publicly, accepts it once on the named entrypoint, then rejects replay", async () => {
    const request = new Request(`${AUDIENCE}/apps/${ORG.appId}/flags`);
    request.headers.set(
      MCP_DELEGATION_HEADER,
      await createMcpDelegationHeader({
        operationId: "flags_list",
        actor: { subject: OWNER, scopes: [`app:${ORG.appId}:admin`] },
        request,
        secret: MCP_DELEGATION_SECRET,
        jti: "index-members-delegation",
      }),
    );

    const publicResponse = await worker.fetch(request.clone(), testEnv, testCtx);
    expect(publicResponse.status).toBe(401);

    const entrypoint = new McpEntrypoint(testCtx, testEnv);
    const accepted = await entrypoint.fetch(request.clone());
    expect(accepted.status).toBe(200);

    const replayed = await entrypoint.fetch(request.clone());
    expect(replayed.status).toBe(401);
  });

  it("fails closed when the delegation secret or replay binding is missing", async () => {
    const request = new Request(`${AUDIENCE}/apps/${ORG.appId}/flags`);
    const missingSecret = new McpEntrypoint(testCtx, {
      ...testEnv,
      MCP_CONTROL_PLANE_DELEGATION_SECRET: undefined,
    });
    await expect(missingSecret.fetch(request.clone())).rejects.toThrow(
      "MCP_CONTROL_PLANE_DELEGATION_SECRET is required",
    );

    const missingReplay = new McpEntrypoint(testCtx, {
      ...testEnv,
      MCP_DELEGATION_REPLAY: undefined,
    });
    await expect(missingReplay.fetch(request)).rejects.toThrow("MCP_DELEGATION_REPLAY is required");
  });
});

async function seedOrgApp(d1: D1Database): Promise<void> {
  const now = new Date(Date.UTC(2026, 6, 1, 12, 0, 0)).toISOString();
  await d1
    .prepare(
      "INSERT OR IGNORE INTO organizations (id, name, plan, created_at, updated_at) VALUES (?,?,?,?,?)",
    )
    .bind(ORG.orgId, "Index Members", "free", now, now)
    .run();
  await d1
    .prepare(
      "INSERT OR IGNORE INTO apps (id, organization_id, name, key, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    )
    .bind(ORG.appId, ORG.orgId, "Index Members App", "index-members", now, now)
    .run();
}
