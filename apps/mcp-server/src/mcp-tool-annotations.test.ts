import {
  getRoute,
  mcpReversibilityMeta,
  mcpToolAnnotations,
  updateClosed,
} from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { jsonRpcError, jsonRpcResult } from "./json-rpc";
import { contextUseTool } from "./mcp-session-context";
import { withToolCallResultMeta } from "./mcp-tool-result-meta";
import { MCP_TOOL_DEFINITIONS } from "./tool-registry";

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

  it("copies irreversible deletion metadata for approval_request_reviews_create", () => {
    const route = getRoute("approval_request_reviews_create");
    expect(route?.effects).toMatchObject({
      mutates: true,
      destructive: true,
      reversibility: "irreversible",
    });

    const response = withToolCallResultMeta(
      jsonRpcResult(1, { structuredContent: { status: "applied" } }),
      {
        name: "approval_request_reviews_create",
        arguments: { id: "apr_1", action: "approve_and_apply" },
      },
    );
    expect("result" in response && response.result).toEqual({
      structuredContent: { status: "applied" },
      _meta: { reversibilityClass: "irreversible" },
    });
  });

  it("leaves JSON-RPC errors unchanged", () => {
    const response = jsonRpcError(1, -32601, "Method not found");
    expect(withToolCallResultMeta(response, { name: "context_use" })).toEqual(response);
  });
});
