import { describe, expect, it } from "vitest";
import { handleMcpServerRequest } from "./mcp-handler";
import {
  allowMcpRevocations,
  staticMcpTokenVerifier,
  TEST_MCP_DELEGATION_SECRET,
} from "./mcp-test-verifier";

describe("MCP invalid tool arguments", () => {
  it("returns JSON-RPC Invalid params for a missing required path argument", async () => {
    const seen: Request[] = [];
    const response = await handleMcpServerRequest({
      request: new Request("https://mcp.test/mcp", {
        method: "POST",
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "organizations_get", arguments: {} },
        }),
      }),
      service: "splitch-mcp-server",
      platformTarget: "local",
      controlPlaneFetch: async (request) => {
        seen.push(request instanceof Request ? request : new Request(request));
        return Response.json({});
      },
      controlPlaneDelegationSecret: TEST_MCP_DELEGATION_SECRET,
      tokenVerifier: staticMcpTokenVerifier(),
      revocations: allowMcpRevocations(),
    });
    const body = (await response.json()) as {
      error?: { code: number; message: string; data?: unknown };
      result?: unknown;
    };

    expect(body.result).toBeUndefined();
    expect(body.error).toEqual({
      code: -32602,
      message: "Invalid params",
      data: {
        argument: "orgId",
        message: 'Missing required argument "orgId".',
      },
    });
    expect(JSON.stringify(body)).not.toContain("control-plane-sdk");
    expect(seen).toEqual([]);
  });
});
