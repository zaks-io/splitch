/**
 * The `tools/call` path, split out of `mcp-handler.ts` so the protocol dispatch
 * and the tool invocation stay separately readable. Everything a tool call needs
 * to reach a Control Plane operation and come back as a JSON-RPC response lives
 * here; the handler owns routing, auth, sessions, and transport.
 */

import {
  type ApiRouteContract,
  type ErrorCode,
  getRoute,
  presentErrorResponse,
  publicSurfaceFor,
} from "@splitch/contracts";
import { IdempotencyKeyRequiredError } from "@splitch/control-plane-sdk/idempotency-header";
import { McpOperationInvalidParamsError } from "@splitch/control-plane-sdk/mcp-operation-adapter";
import type { McpSpanHandle } from "@splitch/observability/mcp-spans";
import {
  JSON_RPC_METHOD_NOT_FOUND,
  type JsonRpcId,
  type JsonRpcResponse,
  jsonRpcError,
  jsonRpcInternalError,
  jsonRpcResult,
} from "./json-rpc";
import { delegationActor, type McpAccessTokenActor } from "./mcp-access-token";
import {
  assertHydratedFlagResult,
  McpFlagReadContractError,
  McpFlagReadUsageError,
  withFlagReadDefaults,
} from "./mcp-flag-read";
import type { McpFaultReporter } from "./mcp-fault";
import { invalidToolArgumentsError } from "./mcp-local-errors";
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
  if (!isPlainObject(call.arguments)) {
    return recordToolResult(fault.span, invalidArgumentsResult(id, call.name));
  }
  if (call.name === "context_use") {
    return dispatchContextUse(
      id,
      call.arguments,
      controlPlane,
      actor,
      sessionId,
      sessionStore,
      sessionContextValidator,
      fault,
    );
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
      return recordToolResult(fault.span, jsonRpcResult(id, errorToolResult(input.error)));
    }
    const operationInput = withFlagReadDefaults(call.name, input.value);
    const result = await sdk.callOperationById(call.name, operationInput, {
      delegation: delegationActor(actor),
    });
    assertHydratedFlagResult(call.name, operationInput, result);
    return recordToolResult(
      fault.span,
      jsonRpcResult(id, result.ok ? toolResult(result.data) : errorToolResult(result.error)),
    );
  } catch (error) {
    return toolCallFailure(id, error, fault);
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
 * Caller-fixable tool refusals (missing path args, missing idempotency keys,
 * Flag-read contradictions) reach the agent as typed `isError` results, not
 * JSON-RPC `-32602`. Unknown tool names stay protocol errors (SEP-1303).
 */
function toolCallFailure(id: JsonRpcId, error: unknown, fault: McpToolCallFault): JsonRpcResponse {
  if (hasTypedErrorResponse(error)) {
    return recordToolResult(fault.span, jsonRpcResult(id, errorToolResult(error.errorResponse)));
  }
  return recordToolResult(fault.span, jsonRpcInternalError(id, error, fault.reportFault));
}

async function dispatchContextUse(
  id: JsonRpcId,
  arguments_: Record<string, unknown>,
  controlPlane: OperationSdkResolver,
  actor: McpAccessTokenActor,
  sessionId: string | null,
  sessionStore: McpSessionStore,
  sessionContextValidator: McpSessionContextValidator | undefined,
  fault: McpToolCallFault,
): Promise<JsonRpcResponse> {
  try {
    return recordToolResult(
      fault.span,
      await contextUse(
        id,
        arguments_,
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

function invalidArgumentsResult(id: JsonRpcId, name: string): JsonRpcResponse {
  return jsonRpcResult(
    id,
    errorToolResult(
      invalidToolArgumentsError(
        [{ path: [], message: "must be an object" }],
        `${name} arguments must be an object`,
      ),
    ),
  );
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
  return jsonRpcResult(id, result.ok ? toolResult(result.value) : errorToolResult(result.error));
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

function hasTypedErrorResponse(error: unknown): error is { errorResponse: { code: ErrorCode } } {
  return (
    error instanceof IdempotencyKeyRequiredError ||
    error instanceof McpOperationInvalidParamsError ||
    error instanceof McpFlagReadUsageError ||
    error instanceof McpFlagReadContractError
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorToolResult(error: { readonly code: ErrorCode }): Record<string, unknown> {
  return toolResult(presentErrorResponse(error), { isError: true });
}

function toolResult(value: unknown, options: { isError?: boolean } = {}): Record<string, unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    ...(options.isError ? { isError: true } : {}),
  };
}
