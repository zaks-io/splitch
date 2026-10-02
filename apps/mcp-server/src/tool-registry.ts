import { deriveMcpProtocolTools, type McpProtocolToolDefinition } from "@splitch/contracts";
import { contextUseTool, type McpSkinToolDefinition } from "./mcp-session-context";

export const MCP_TOOL_DEFINITIONS: readonly (McpProtocolToolDefinition | McpSkinToolDefinition)[] =
  [...deriveMcpProtocolTools(), contextUseTool];
