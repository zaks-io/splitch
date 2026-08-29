/**
 * The `tools/call` path, split out of `mcp-handler.ts` so the protocol dispatch
 * and the tool invocation stay separately readable. Everything a tool call needs
 * to reach a Control Plane operation and come back as a JSON-RPC response lives
 * here; the handler owns routing, auth, sessions, and transport.
 */

import {
  type ApiRouteContract,
  getRoute,
  HydratedFlagListResponseSchema,
  HydratedFlagResponseSchema,
  publicSurfaceFor,
} from "@splitch/contracts";
import { IdempotencyKeyRequiredError } from "@splitch/control-plane-sdk/idempotency-header";
import { McpOperationInvalidParamsError } from "@splitch/control-plane-sdk/mcp-operation-adapter";
import type { McpSpanHandle } from "@splitch/observability/mcp-spans";
import {
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_METHOD_NOT_FOUND,
  type JsonRpcId,
  type JsonRpcResponse,
  jsonRpcError,
  jsonRpcInternalError,
  jsonRpcResult,
} from "./json-rpc";
import type { McpAccessTokenActor } from "./mcp-access-token";
import type { McpFaultReporter } from "./mcp-fault";
import type { OperationSdk, OperationSdkResolver } from "./mcp-operation-sdks";
import {
  type McpSessionContextValidator,
  type McpSessionStore,
  parseToolCall,
  resolveScope,
  setSessionContext,
} from "./mcp-session-context";
import { controlPlaneContextValidator } from "./mcp-session-context-validator";
import { MCP_TOOL_DEFINITIONS } from "./tool-registry";

const toolNames = new Set(MCP_TOOL_DEFINITIONS.map((tool) => tool.name));

/** The fault sinks a tool call reports through: Sentry span, and operator log. */
export interface McpToolCallFault {
  readonly reportFault: McpFaultReporter;
  readonly span: McpSpanHandle;
}

export async function callTool(
  id: JsonRpcId,
  params: unknown,
  controlPlane: OperationSdkResolver,
  actor: McpAccessTokenActor,
  sessionId: string | null,
  sessionStore: McpSessionStore,
  sessionContextValidator: McpSessionContextValidator | undefined,
  fault: McpToolCallFault,
): Promise<JsonRpcResponse> {
  const call = parseToolCall(params);
  if (!call || !toolNames.has(call.name)) {
    return recordToolResult(
      fault.span,
      jsonRpcError(id, JSON_RPC_METHOD_NOT_FOUND, "Method not found"),
    );
  }
  if (call.name === "context_use") {
    try {
      return recordToolResult(
        fault.span,
        await contextUse(
          id,
          call.arguments,
          sessionId,
          sessionStore,
          sessionContextValidator ?? controlPlaneContextValidator(controlPlane, actor),
          actor.subject,
        ),
      );
    } catch (error) {
      return toolCallFailure(id, error, fault);
    }
  }
  const route = getRoute(call.name);
  if (!route) {
    return recordToolResult(
      fault.span,
      jsonRpcError(id, JSON_RPC_METHOD_NOT_FOUND, "Method not found"),
    );
  }

  try {
    const sdk = controlPlaneSdkForRoute(controlPlane, route);
    const input = await resolveScope(
      route.path,
      call.arguments,
      sessionId,
      sessionStore,
      actor.subject,
    );
    if (!input.ok) {
      return recordToolResult(
        fault.span,
        jsonRpcResult(id, toolResult({ message: input.message }, { isError: true })),
      );
    }
    const operationInput = withFlagReadDefaults(call.name, input.value);
    const result = await sdk.callOperationById(call.name, operationInput, {
      delegation: { subject: actor.subject, scopes: actor.scopes, authDoor: actor.authDoor },
    });
    assertHydratedFlagResult(call.name, operationInput, result);
    return recordToolResult(
      fault.span,
      jsonRpcResult(
        id,
        result.ok ? toolResult(result.data) : toolResult(result.error, { isError: true }),
      ),
    );
  } catch (error) {
    return toolCallFailure(id, error, fault);
  }
}

function withFlagReadDefaults(
  operationId: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (operationId !== "flags_list" && operationId !== "flags_get") return input;
  const { summary, ...requestInput } = input;
  if (summary === true) {
    // `envs` is only accepted alongside `include=config`, so dropping `include`
    // while keeping `envs` would hand the Worker a request it must reject. Both
    // fields contradict `summary`; say so instead of silently picking a winner.
    const conflict = ["include", "envs"].find((field) => requestInput[field] !== undefined);
    if (conflict) throw new McpFlagReadUsageError(operationId, conflict);
    return requestInput;
  }
  if (requestInput.include !== undefined) return requestInput;
  if (
    operationId === "flags_list" &&
    typeof requestInput.environmentId === "string" &&
    requestInput.envs === undefined
  ) {
    const { environmentId, ...hydratedInput } = requestInput;
    return { ...hydratedInput, include: "config", envs: environmentId };
  }
  return { ...requestInput, include: "config" };
}

function assertHydratedFlagResult(
  operationId: string,
  input: Record<string, unknown>,
  result: { ok: true; data: unknown } | { ok: false },
): void {
  if (!result.ok || input.include !== "config") return;
  const payload = result.data;
  if (operationId === "flags_list") {
    if (HydratedFlagListResponseSchema.safeParse(payload).success) return;
  } else if (operationId === "flags_get") {
    if (HydratedFlagResponseSchema.safeParse(payload).success) return;
  } else {
    return;
  }
  throw new McpFlagReadContractError(operationId);
}

/**
 * `summary` is the compact-response opt-out, so pairing it with a hydration
 * field is a contradiction the caller controls. It reaches the agent as the
 * same typed `VALIDATION_ERROR` tool result the idempotency rule uses, naming
 * the field to drop (SPL-266, ADR-0036).
 */
class McpFlagReadUsageError extends Error {
  readonly errorResponse: Record<string, unknown>;

  constructor(operationId: string, conflictingField: string) {
    const detail = `${operationId} cannot combine summary with ${conflictingField}: drop ${conflictingField} for the compact response, or drop summary for complete Flag Configurations`;
    super(detail);
    this.name = "McpFlagReadUsageError";
    this.errorResponse = {
      code: "VALIDATION_ERROR",
      message: detail,
      details: { issues: [{ path: [conflictingField], message: "conflicts with summary" }] },
    };
  }
}

class McpFlagReadContractError extends Error {
  readonly errorResponse: Record<string, unknown>;

  constructor(operationId: string) {
    const message = `${operationId} requested complete Flag Configurations but received an unhydrated response`;
    super(message);
    this.name = "McpFlagReadContractError";
    this.errorResponse = {
      code: "INTERNAL_SERVER_ERROR",
      message,
      remediation:
        "Update the server to the SPL-529 Flag-read contract or report the response mismatch",
      recommendedAction: "UPDATE_SERVER",
      docsUrl: "https://splitch.dev/docs/error/INTERNAL_SERVER_ERROR",
      details: { fault: "FLAG_READ_CONTRACT_MISMATCH" },
    };
  }
}

/**
 * Reads the outcome off the response we are about to return rather than off the
 * branch that produced it. A tool "failure" reaches the agent four ways here
 * (scope refusal, typed error envelope, thrown fault, JSON-RPC error), and
 * setting the attribute per branch is how one of them ends up unlabelled.
 *
 * Only the SHAPE is recorded -- `isError` and a content count. The content itself
 * carries flag keys, Targeting Keys, and Evaluation Context, so it stays out of
 * the span (ADR-0032); Sentry gates the same data behind `recordOutputs`.
 */
function recordToolResult(span: McpSpanHandle, response: JsonRpcResponse): JsonRpcResponse {
  if ("error" in response) {
    span.setToolResult({ isError: true, contentCount: 0 });
    return response;
  }
  const result = response.result as { isError?: boolean; content?: unknown[] };
  span.setToolResult({
    isError: result.isError === true,
    contentCount: Array.isArray(result.content) ? result.content.length : 0,
  });
  return response;
}

/**
 * A missing idempotency key is a caller-fixable precondition, so it reaches the
 * agent as a typed `VALIDATION_ERROR` tool result — the same code and envelope the
 * Worker uses for that rule — rather than a protocol fault. `Internal error` stays
 * the last resort for genuinely unexpected throws (SPL-266).
 *
 * The promise is scoped to this rule: other refusals on this path (scope
 * resolution) still return an untyped message with no `code`.
 */
function toolCallFailure(id: JsonRpcId, error: unknown, fault: McpToolCallFault): JsonRpcResponse {
  if (error instanceof IdempotencyKeyRequiredError) {
    return recordToolResult(
      fault.span,
      jsonRpcResult(id, toolResult(error.errorResponse, { isError: true })),
    );
  }
  if (error instanceof McpOperationInvalidParamsError) {
    return recordToolResult(
      fault.span,
      jsonRpcError(id, JSON_RPC_INVALID_PARAMS, "Invalid params", {
        argument: error.argument,
        message: error.message,
      }),
    );
  }
  if (error instanceof McpFlagReadUsageError) {
    return recordToolResult(
      fault.span,
      jsonRpcResult(id, toolResult(error.errorResponse, { isError: true })),
    );
  }
  if (error instanceof McpFlagReadContractError) {
    return recordToolResult(
      fault.span,
      jsonRpcResult(id, toolResult(error.errorResponse, { isError: true })),
    );
  }
  return recordToolResult(fault.span, jsonRpcInternalError(id, error, fault.reportFault));
}

async function contextUse(
  id: JsonRpcId,
  arguments_: unknown,
  sessionId: string | null,
  sessionStore: McpSessionStore,
  validate: McpSessionContextValidator,
  subject: string,
): Promise<JsonRpcResponse> {
  const result = await setSessionContext(arguments_, sessionId, sessionStore, validate, subject);
  return jsonRpcResult(
    id,
    result.ok
      ? toolResult(result.value)
      : toolResult({ message: result.message }, { isError: true }),
  );
}

/**
 * The one place an MCP tool call acquires a downstream, so there is one place to
 * check that it is the Control Plane. A management tool is addressed at the
 * surface its credential belongs to (ADR-0046); a derived tool whose route is
 * addressed anywhere else would be one the Control Plane's D1 membership,
 * Environment-scope, and Policy gates never see, so refuse it rather than send it.
 */
export function controlPlaneSdkForRoute(
  controlPlane: OperationSdkResolver,
  route: ApiRouteContract,
): OperationSdk {
  const surface = publicSurfaceFor(route);
  if (surface !== "control-plane-api") {
    throw new Error(
      `mcp-server: tool "${route.operationId}" is addressed at ${surface ?? "no public surface"}, not the Control Plane`,
    );
  }
  return controlPlane();
}

function toolResult(value: unknown, options: { isError?: boolean } = {}): Record<string, unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    ...(options.isError ? { isError: true } : {}),
  };
}
