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
  it("returns an isError result for invalid arguments on every advertised tool", async () => {
    expect(MCP_TOOL_DEFINITIONS.length).toBeGreaterThan(0);
    const seen: Request[] = [];

    for (const tool of MCP_TOOL_DEFINITIONS) {
      const body = await callTool(tool.name, invalidArgumentsFor(tool), seen);
      expect(body.error, `${tool.name} must not be a JSON-RPC protocol error`).toBeUndefined();
      expect(body.result?.isError, `${tool.name} must return isError`).toBe(true);
      expect(typeof body.result?.structuredContent?.code, `${tool.name} code`).toBe("string");
    }

    expect(seen).toEqual([]);
  });

  it("keeps an unknown tool name as a JSON-RPC protocol error", async () => {
    const body = await callTool("missing_tool", {}, []);
    expect(body.result).toBeUndefined();
    expect(body.error).toMatchObject({ code: -32601, message: "Method not found" });
  });
});

function invalidArgumentsFor(tool: { inputSchema: Record<string, unknown> }): unknown {
  const schema = tool.inputSchema;
  if (schema.type !== "object") {
    throw new Error(`advertised tool schema must be an object, got ${String(schema.type)}`);
  }
  // A non-object is invalid against every advertised object schema, including
  // no-argument tools, and is refused before any Control Plane fetch (SEP-1303).
  return 1;
}

interface ToolCallBody {
  result?: { isError?: boolean; structuredContent?: { code?: string } };
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
