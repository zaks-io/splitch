import { describe, expect, it } from "vitest";
import { mcpReversibilityMeta, mcpToolAnnotations, updateClosed } from "@splitch/contracts";
import { jsonRpcError, jsonRpcResult } from "./json-rpc";
import { contextUseTool } from "./mcp-session-context";
import { MCP_TOOL_DEFINITIONS } from "./tool-registry";
import { withToolCallResultMeta } from "./mcp-tool-result-meta";

describe("context_use annotations", () => {
  it("advertises the same hints and reversibility class as mutating session writes", () => {
    expect(contextUseTool.annotations).toEqual(mcpToolAnnotations(updateClosed));
    expect(contextUseTool._meta).toEqual(mcpReversibilityMeta(updateClosed));
    expect(contextUseTool.annotations.readOnlyHint).toBe(false);
    expect(MCP_TOOL_DEFINITIONS.some((tool) => tool.name === "context_use")).toBe(true);
  });
});

describe("tool call result metadata", () => {
  it("copies the advertised reversibility class onto success results", () => {
    const response = withToolCallResultMeta(jsonRpcResult(1, { structuredContent: { ok: true } }), {
      name: "context_use",
      arguments: { appId: "app_1", environmentId: "env_1" },
    });
    expect("result" in response && response.result).toEqual({
      structuredContent: { ok: true },
      _meta: { reversibilityClass: "reversible" },
    });
  });

  it("leaves JSON-RPC errors unchanged", () => {
    const response = jsonRpcError(1, -32601, "Method not found");
    expect(withToolCallResultMeta(response, { name: "context_use" })).toEqual(response);
  });
});
