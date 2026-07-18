import { CLI_COMMANDS, META_COMMANDS } from "../apps/cli/src/command-registry.js";
import { MCP_TOOL_DEFINITIONS } from "../apps/mcp-server/src/tool-registry.js";
import { operationIds } from "../packages/contracts/src/index.js";
import { assertCliMcpParity } from "./lib/cli-mcp-parity.mjs";

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

console.log(
  `CLI/MCP parity passed: ${cliOperationIds.length} CLI operations, ${mcpOperationIds.length} MCP tools`,
);
