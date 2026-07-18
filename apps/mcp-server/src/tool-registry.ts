import { deriveMcpProtocolTools } from "@splitch/contracts";
import { contextUseTool } from "./mcp-session-context";

export const MCP_TOOL_DEFINITIONS = [...deriveMcpProtocolTools(), contextUseTool] as const;
