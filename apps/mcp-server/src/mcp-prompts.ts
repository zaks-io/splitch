import { recommendedActions } from "@splitch/contracts";
import {
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_METHOD_NOT_FOUND,
  type JsonRpcId,
  type JsonRpcResponse,
  jsonRpcError,
  jsonRpcResult,
} from "./json-rpc";
import {
  diagnoseSetupPlan,
  endARunPlan,
  onboardNewAppPlan,
  runAnExperimentPlan,
  shipAFlagPlan,
} from "./mcp-prompt-plans";
import { recoverFromErrorPlan } from "./mcp-prompt-recovery";
import {
  type McpPromptDefinition,
  type McpPromptPlan,
  type McpPromptResult,
  PROMPT_DEFINITIONS,
  PromptArgumentError,
  PromptNotFoundError,
  requireString,
} from "./mcp-prompt-types";
import { MCP_TOOL_DEFINITIONS } from "./tool-registry";

/**
 * MCP prompts are advisory plan templates (mcp-discovery.md). They return a
 * message sequence naming derived tools by operationId — they never execute
 * tools and never mutate. Every referenced operationId must exist in the
 * S08-derived tool set (deriveMcpProtocolTools + context_use).
 */

export function listMcpPrompts(): { prompts: readonly McpPromptDefinition[] } {
  return { prompts: PROMPT_DEFINITIONS };
}

export function getPromptPlan(name: string, args: Record<string, unknown> = {}): McpPromptPlan {
  switch (name) {
    case "onboard_new_app":
      return onboardNewAppPlan(requireString(args, "orgId"), requireString(args, "appName"));
    case "ship_a_flag":
      return shipAFlagPlan(requireString(args, "flagKey"), requireString(args, "variants"));
    case "run_an_experiment":
      return runAnExperimentPlan(
        requireString(args, "flagId"),
        requireString(args, "variants"),
        requireString(args, "allocation"),
      );
    case "end_a_run":
      return endARunPlan(requireString(args, "runId"));
    case "recover_from_error":
      return recoverFromErrorPlan(requireString(args, "errorCode"), args.details);
    case "diagnose_setup":
      return diagnoseSetupPlan();
    default:
      throw new PromptNotFoundError(name);
  }
}

export function getMcpPrompt(name: string, args: Record<string, unknown> = {}): McpPromptResult {
  const plan = getPromptPlan(name, args);
  return { description: plan.description, messages: plan.messages };
}

/** All plans with representative args — used by the operationId drift guard. */
export function allPromptPlans(): readonly McpPromptPlan[] {
  return [
    getPromptPlan("onboard_new_app", { orgId: "org_example", appName: "Example App" }),
    getPromptPlan("ship_a_flag", { flagKey: "checkout", variants: "on,off" }),
    getPromptPlan("run_an_experiment", {
      flagId: "flag_example",
      variants: "control,treatment",
      allocation: "50,50",
    }),
    getPromptPlan("end_a_run", { runId: "run_example" }),
    ...recommendedActions.map((action) =>
      getPromptPlan("recover_from_error", {
        errorCode: "EXPERIMENT_RUNNING",
        details: { recommendedAction: action, retryAfterMs: 1000, runningRunId: "run_example" },
      }),
    ),
    getPromptPlan("diagnose_setup"),
  ];
}

export function s08DerivedToolNames(): ReadonlySet<string> {
  return new Set(MCP_TOOL_DEFINITIONS.map((tool) => tool.name));
}

/**
 * Fail-loud drift guard: every operationId referenced by a plan must exist in
 * the S08-derived tool set. Throws with the unknown ids so CI reports the drift.
 */
export function assertPromptOperationIds(
  operationIds: readonly string[],
  knownTools: ReadonlySet<string> = s08DerivedToolNames(),
): void {
  const unknown = [...new Set(operationIds)].filter((id) => !knownTools.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `mcp-prompts: unknown operationId(s) not in S08-derived tool set: ${unknown.join(", ")}`,
    );
  }
}

export function assertAllPromptOperationIds(
  knownTools: ReadonlySet<string> = s08DerivedToolNames(),
): void {
  for (const plan of allPromptPlans()) {
    assertPromptOperationIds(plan.operationIds, knownTools);
  }
}

export function getMcpPromptRpc(id: JsonRpcId, params: unknown): JsonRpcResponse {
  const request = parsePromptGet(params);
  if (!request) {
    return jsonRpcError(id, JSON_RPC_METHOD_NOT_FOUND, "Method not found");
  }
  try {
    return jsonRpcResult(id, getMcpPrompt(request.name, request.arguments));
  } catch (error) {
    if (error instanceof PromptNotFoundError) {
      return jsonRpcError(id, JSON_RPC_METHOD_NOT_FOUND, "Method not found", {
        message: error.message,
      });
    }
    if (error instanceof PromptArgumentError) {
      return jsonRpcError(id, JSON_RPC_INVALID_PARAMS, "Invalid params", {
        message: error.message,
      });
    }
    throw error;
  }
}

function parsePromptGet(
  params: unknown,
): { name: string; arguments: Record<string, unknown> } | null {
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const { name, arguments: args } = params as {
    name?: unknown;
    arguments?: unknown;
  };
  if (typeof name !== "string" || name.length === 0) return null;
  if (args === undefined) return { name, arguments: {} };
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  return { name, arguments: args as Record<string, unknown> };
}
