import { CLI_COMMANDS, META_COMMANDS } from "../apps/cli/src/command-registry.js";
import {
  renderCommandHelp,
  renderHelp,
  renderMetaHelp,
  renderRootHelp,
} from "../apps/cli/src/help.js";
import { MCP_TOOL_DEFINITIONS } from "../apps/mcp-server/src/tool-registry.js";
import { operationIds } from "../packages/contracts/src/index.js";
import { assertCliMcpParity, assertPublicAgentSurface } from "./lib/cli-mcp-parity.mjs";

// These routes intentionally do not have equal CLI and MCP exposure. Keeping
// the list explicit makes every new exception a reviewed contract decision.
const CONTRACT_EXCEPTIONS = [
  {
    operationId: "openapi_document_get",
    cli: false,
    mcp: false,
    reason: "public discovery route, not an authenticated operation",
  },
  {
    operationId: "sdk_evaluate",
    cli: false,
    mcp: false,
    reason: "SDK data-plane operation",
  },
  {
    operationId: "sdk_evaluate_all",
    cli: false,
    mcp: false,
    reason: "SDK data-plane operation",
  },
  {
    operationId: "sdk_cached_evaluation_telemetry",
    cli: false,
    mcp: false,
    reason: "SDK data-plane telemetry operation",
  },
  {
    operationId: "sdk_peek",
    cli: false,
    mcp: false,
    reason: "SDK data-plane diagnostic operation",
  },
  {
    operationId: "sdk_verify",
    cli: true,
    mcp: false,
    reason: "CLI setup check using an SDK credential; agents use flags_test_eval",
  },
] as const;

const cliOperationIds = [...new Set(CLI_COMMANDS.map((command) => command.operationId))];
const mcpOperationIds = MCP_TOOL_DEFINITIONS.filter((tool) => tool.name !== "context_use").map(
  (tool) => tool.name,
);

assertCliMcpParity({
  contractOperationIds: operationIds,
  cliOperationIds,
  mcpOperationIds,
  exceptions: CONTRACT_EXCEPTIONS,
  skinLocalCapabilities: [
    {
      name: "active context selection",
      cliPresent: META_COMMANDS.includes("use"),
      mcpPresent: MCP_TOOL_DEFINITIONS.some((tool) => tool.name === "context_use"),
    },
  ],
});

const groups = [...new Set(CLI_COMMANDS.map((command) => command.path[0]).filter(Boolean))].sort();
assertPublicAgentSurface({
  cliHelp: [
    { name: "root", text: renderRootHelp() },
    ...groups.map((group) => ({
      name: group,
      text: renderHelp([group ?? "", "--help"]) ?? "",
    })),
    ...META_COMMANDS.map((command) => ({ name: command, text: renderMetaHelp(command) })),
    ...CLI_COMMANDS.map((command) => ({
      name: command.path.join(" "),
      text: renderCommandHelp(command),
    })),
  ],
  mcpTools: MCP_TOOL_DEFINITIONS,
});

console.log(
  `CLI/MCP parity and published-surface gate passed: ${cliOperationIds.length} CLI operations, ${mcpOperationIds.length} MCP tools`,
);
