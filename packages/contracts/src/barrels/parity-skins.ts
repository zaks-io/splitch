// biome-ignore-all lint/performance/noBarrelFile: internal sub-barrel of ../index.ts, which stays the only supported import path for these symbols

// The two agent-facing skins derived from the route registry (ADR-0023): the
// CLI command path and the MCP tool surface. Grouped so a consumer that needs
// one naming rule gets the other from the same place and they cannot drift.
export type { CliPresentationAliasOperationId } from "../cli-command-path";
export {
  CLI_PRESENTATION_ALIAS_PATHS,
  cliCommandPath,
  cliCommandString,
  cliPresentationAliasString,
} from "../cli-command-path";
export type { McpProtocolToolDefinition, McpToolDefinition } from "../mcp-tools";
export { deriveMcpProtocolTools, deriveMcpTools, isMcpToolRoute } from "../mcp-tools";
