import { describe, expect, it } from "vitest";
import { handleMcpServerRequest } from "./mcp-handler";
import {
  allowMcpRevocations,
  staticMcpTokenVerifier,
  TEST_MCP_DELEGATION_SECRET,
} from "./mcp-test-verifier";
import { MCP_TOOL_DEFINITIONS } from "./tool-registry";

/**
 * SEP-1303: invalid tool arguments are `isError` results with a stable code.
 * Generated from the advertised registry so a new tool cannot skip the rule
 * by leaving a hardcoded count stale.
 */
describe("MCP invalid tool arguments contract", () => {
  it.each([1, null, "string", true, []])(
    "returns an isError result for non-object arguments (%j) on every advertised tool",
    async (invalidArguments) => {
      expect(MCP_TOOL_DEFINITIONS.length).toBeGreaterThan(0);
      const seen: Request[] = [];

      for (const tool of MCP_TOOL_DEFINITIONS) {
        const body = await callTool(tool.name, invalidArguments, seen);
        expect(body.error, `${tool.name} must not be a JSON-RPC protocol error`).toBeUndefined();
        expect(body.result?.isError, `${tool.name} must return isError`).toBe(true);
        expect(body.result?.structuredContent).toMatchObject({
          code: "VALIDATION_ERROR",
          message: `${tool.name} arguments must be an object`,
          details: { issues: [{ path: [], message: "must be an object" }] },
        });
      }

      expect(seen).toEqual([]);
    },
  );

  it("keeps an unknown tool name as a JSON-RPC protocol error", async () => {
    const body = await callTool("missing_tool", {}, []);
    expect(body.result).toBeUndefined();
    expect(body.error).toMatchObject({ code: -32601, message: "Method not found" });
  });
});

interface ToolCallBody {
  result?: {
    isError?: boolean;
    structuredContent?: {
      code?: string;
      message?: string;
      details?: { issues?: Array<{ path: string[]; message: string }> };
    };
  };
  error?: { code: number; message: string };
}

async function callTool(name: string, arguments_: unknown, seen: Request[]): Promise<ToolCallBody> {
  const response = await handleMcpServerRequest({
    request: new Request("https://mcp.test/mcp", {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: arguments_ },
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
  return (await response.json()) as ToolCallBody;
}
