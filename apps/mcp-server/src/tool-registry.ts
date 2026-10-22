import {
  deriveMcpProtocolTools,
  isMcpToolRoute,
  type McpProtocolToolDefinition,
  routeRegistry,
} from "@splitch/contracts";
import { contextUseTool, type McpSkinToolDefinition } from "./mcp-session-context";

export const MCP_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...routeRegistry.filter(isMcpToolRoute).map((route) => route.operationId),
  contextUseTool.name,
]);

let definitions: readonly (McpProtocolToolDefinition | McpSkinToolDefinition)[] | undefined;

/** JSON schemas are needed by tools/list, not by initialization or tools/call. */
export function mcpToolDefinitions(): readonly (
  | McpProtocolToolDefinition
  | McpSkinToolDefinition
)[] {
  definitions ??= [...deriveMcpProtocolTools(), contextUseTool];
  return definitions;
}
