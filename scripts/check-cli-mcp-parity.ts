import { CLI_COMMANDS, META_COMMANDS } from "../apps/cli/src/command-registry.js";
import {
  renderCommandHelp,
  renderHelp,
  renderMetaHelp,
  renderRootHelp,
} from "../apps/cli/src/help.js";
import { getPromptPlan } from "../apps/mcp-server/src/mcp-prompts.js";
import { QUICKSTART_MD } from "../apps/mcp-server/src/mcp-resource-files.generated.js";
import { listMcpResources } from "../apps/mcp-server/src/mcp-resources.js";
import { MCP_TOOL_DEFINITIONS } from "../apps/mcp-server/src/tool-registry.js";
import {
  deriveMcpProtocolTools,
  operationIds,
  recommendedActions,
  routeRegistry,
} from "../packages/contracts/src/index.js";
import {
  assertCliMcpParity,
  assertDerivedMcpSchemaParity,
  assertPublicAgentSurface,
} from "./lib/cli-mcp-parity.mjs";
import { assertSharedOperationParity } from "./lib/cli-mcp-shared-operation.js";

// These routes intentionally do not have equal CLI and MCP exposure. Keeping
// the list explicit makes every new exception a reviewed contract decision.
const CONTRACT_EXCEPTIONS = [
  {
    operationId: "environment_exposure_status_delete",
    cli: false,
    mcp: false,
    reason:
      "binding-only internal Worker route (auth internal-worker); excluded from every public surface",
  },
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
    operationId: "sdk_exposures",
    cli: false,
    mcp: false,
    reason: "SDK data-plane operation",
  },
  {
    operationId: "sdk_track",
    cli: false,
    mcp: false,
    reason: "SDK Metric Event data-plane operation",
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

const promptPlans = [
  {
    name: "onboard_new_app",
    plan: getPromptPlan("onboard_new_app", { orgId: "org_example", appName: "Example App" }),
  },
  {
    name: "ship_a_flag",
    plan: getPromptPlan("ship_a_flag", { flagKey: "checkout", variants: "on,off" }),
  },
  {
    name: "run_an_experiment",
    plan: getPromptPlan("run_an_experiment", {
      flagId: "flag_example",
      variants: "control,treatment",
      allocation: "50,50",
    }),
  },
  { name: "end_a_run", plan: getPromptPlan("end_a_run", { runId: "run_example" }) },
  { name: "diagnose_setup", plan: getPromptPlan("diagnose_setup") },
  ...recommendedActions.map((action) => ({
    name: `recover_from_error:${action}`,
    plan: getPromptPlan("recover_from_error", {
      errorCode: "FIXTURE",
      details: { recommendedAction: action },
    }),
  })),
];

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
  mcpPrompts: promptPlans.flatMap(({ name, plan }) => [
    { name: `${name}:description`, text: plan.description },
    ...plan.messages.map((message, index) => ({
      name: `${name}:message[${index}]`,
      text: message.content.text,
    })),
  ]),
  mcpResources: [
    ...listMcpResources().resources.map((resource) => ({
      name: `${resource.uri}:description`,
      text: resource.description,
    })),
    // CONTEXT.md is an internal glossary with repo path map; only the
    // agent-facing quickstart must stay free of repo-internal references.
    { name: "splitch://quickstart", text: QUICKSTART_MD },
  ],
  // Covers routes with no CLI help or MCP tool (openapi_document_get,
  // sdk_evaluate, sdk_cached_evaluation_telemetry, sdk_peek, …).
  routeSummaries: routeRegistry.map((route) => ({
    name: route.operationId,
    text: route.summary,
  })),
});

// The CLI validates command input against the route-derived Zod schemas
// (apps/cli/src/operation-input.ts reads `deriveMcpTools()`); MCP publishes the
// JSON Schema of those same schemas in tools/list. Comparing the canonical
// derivation against what the tool registry actually ships catches an MCP-side
// override or wrapper that would let the two skins accept different input.
const derivedSchemas = new Map(
  deriveMcpProtocolTools()
    .filter((tool) => mcpOperationIds.includes(tool.name))
    .map((tool) => [tool.name, { input: tool.inputSchema, output: tool.outputSchema }]),
);
const publishedSchemas = new Map(
  MCP_TOOL_DEFINITIONS.filter((tool) => mcpOperationIds.includes(tool.name)).map((tool) => [
    tool.name,
    { input: tool.inputSchema, output: tool.outputSchema },
  ]),
);
const sharedSchemas = assertDerivedMcpSchemaParity({ derivedSchemas, publishedSchemas });

const sharedOperations = await assertSharedOperationParity();

console.log(
  `CLI/MCP parity and published-surface gate passed: ${cliOperationIds.length} CLI operations, ${mcpOperationIds.length} MCP tools, ${sharedSchemas} identical tool schemas, ${sharedOperations} shared-operation runs through both surfaces`,
);
