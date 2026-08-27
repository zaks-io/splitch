import { beforeAll, describe, expect, it } from "vitest";
import type { ControlPlaneApiEnv } from "../src/env.js";
import { McpEntrypoint } from "../src/index.js";
import {
  MCP_DELEGATION_SECRET,
  OWNER,
  setupMcpDoorTestEnv,
  TENANT_A,
  testCtx,
} from "./index-mcp-fixtures.js";

let testEnv: ControlPlaneApiEnv;

beforeAll(async () => {
  testEnv = await setupMcpDoorTestEnv();
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
          params: { name: "flags_list", arguments: { appId: TENANT_A.appId } },
        }),
      }),
      service: "splitch-mcp-server",
      platformTarget: "local",
      tokenVerifier: {
        verify: async () => ({
          subject: OWNER,
          scopes: [`app:${TENANT_A.appId}:admin`],
          authDoor: "id_jag",
        }),
      },
      revocations: { isRevoked: async () => false },
      controlPlaneFetch: (request: RequestInfo | URL, init?: RequestInit) =>
        entrypoint.fetch(request instanceof Request ? request : new Request(request, init)),
      controlPlaneDelegationSecret: MCP_DELEGATION_SECRET,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: {
        structuredContent: {
          items: [expect.objectContaining({ id: TENANT_A.flagId, key: TENANT_A.flagKey })],
        },
      },
    });
  });
});
