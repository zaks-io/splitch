// Wire names verified in official clients. Keep aliases exact so caller text
// never becomes telemetry, even when it contains a recognizable product name.
// https://github.com/openai/codex/blob/rust-v0.114.0/codex-rs/core/src/mcp_connection_manager.rs#L1332-L1338
// https://github.com/modelcontextprotocol/inspector/blob/0.16.2/client/src/lib/hooks/useConnection.ts#L321-L325
const MCP_CLIENT_NAMES = {
  codex: ["codex-mcp-client"],
  "mcp-inspector": [],
  other: [],
} as const satisfies Record<string, readonly string[]>;

type McpClientName = keyof typeof MCP_CLIENT_NAMES;

export function isCanonicalMcpClientName(value: unknown): value is McpClientName {
  return typeof value === "string" && Object.hasOwn(MCP_CLIENT_NAMES, value);
}

export function canonicalizeMcpClientName(value: unknown): McpClientName {
  if (typeof value !== "string") return "other";
  const normalized = value.trim().toLowerCase();
  for (const [canonical, aliases] of Object.entries(MCP_CLIENT_NAMES)) {
    if (normalized === canonical || (aliases as readonly string[]).includes(normalized)) {
      return canonical as McpClientName;
    }
  }
  return "other";
}
