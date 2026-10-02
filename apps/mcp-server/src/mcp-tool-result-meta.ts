import { getRoute, mcpReversibilityMeta, updateClosed } from "@splitch/contracts";
import type { JsonRpcResponse } from "./json-rpc";
import { parseToolCall } from "./mcp-session-context";

/** Attach D8 reversibility metadata to a tools/call result without changing error paths. */
export function withToolCallResultMeta(
  response: JsonRpcResponse,
  params: unknown,
): JsonRpcResponse {
  if (!("result" in response) || response.result === null || typeof response.result !== "object") {
    return response;
  }
  const call = parseToolCall(params);
  if (!call) return response;
  const effects = call.name === "context_use" ? updateClosed : getRoute(call.name)?.effects;
  if (!effects) return response;
  return {
    ...response,
    result: {
      ...(response.result as Record<string, unknown>),
      _meta: mcpReversibilityMeta(effects),
    },
  };
}
