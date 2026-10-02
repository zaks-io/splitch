import { describe, expect, it } from "vitest";
import { handleMcpServerRequest } from "./mcp-handler";
import {
  allowMcpRevocations,
  staticMcpTokenVerifier,
  TEST_MCP_DELEGATION_SECRET,
} from "./mcp-test-verifier";

/**
 * Missing or non-string path parameters used to be JSON-RPC `-32602`. SEP-1303
 * routes that class of invalid arguments to a typed `isError` tool result.
 */
describe("MCP invalid tool arguments", () => {
  it("returns a typed VALIDATION_ERROR tool result for a missing required path argument", async () => {
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
      error?: unknown;
      result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
    };

    expect(body.error).toBeUndefined();
    expect(body.result).toMatchObject({
      isError: true,
      structuredContent: {
        code: "VALIDATION_ERROR",
        outcome: "user_action_required",
        details: { issues: [{ path: ["orgId"], message: "required" }] },
      },
    });
    expect(seen).toEqual([]);
  });
});
