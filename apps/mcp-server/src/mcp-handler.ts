import {
  type ApiRouteContract,
  getRoute,
  parsePlatformTarget,
  publicSurfaceFor,
} from "@splitch/contracts";
import { IdempotencyKeyRequiredError } from "@splitch/control-plane-sdk/idempotency-header";
import { McpOperationInvalidParamsError } from "@splitch/control-plane-sdk/mcp-operation-adapter";
import {
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_METHOD_NOT_FOUND,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  jsonRpcError,
  jsonRpcResult,
} from "./json-rpc";
import {
  type McpAccessTokenActor,
  type McpAccessTokenVerifier,
  makeHttpMcpAccessTokenVerifier,
} from "./mcp-access-token";
import {
  createControlPlaneOperationSdk,
  type OperationSdk,
  type OperationSdkResolver,
} from "./mcp-operation-sdks";
import { getMcpPromptRpc, listMcpPrompts } from "./mcp-prompts";
import { readJsonRpcRequest } from "./mcp-request";
import { listMcpResources, readMcpResourceRpc } from "./mcp-resources";
import {
  type McpSessionContextValidator,
  type McpSessionStore,
  type McpSessionTransport,
  parseToolCall,
  resolveScope,
  setSessionContext,
} from "./mcp-session-context";
import { controlPlaneContextValidator } from "./mcp-session-context-validator";
import { corsHeaders, jsonResponse, routeTransportRequest } from "./mcp-transport";
import { MCP_TOOL_DEFINITIONS } from "./tool-registry";

const protocolVersion = "2025-06-18";
const toolNames = new Set(MCP_TOOL_DEFINITIONS.map((tool) => tool.name));

export interface McpRevocationReader {
  isRevoked(subject: string): Promise<boolean>;
}

export interface McpServerRequestOptions {
  readonly request: Request;
  readonly service: string;
  readonly deployedCommitSha?: string;
  readonly platformTarget?: string;
  readonly authBaseUrl?: string;
  readonly controlPlaneBaseUrl?: string;
  readonly controlPlaneFetch?: typeof fetch;
  readonly controlPlaneDelegationSecret?: string;
  readonly sessionStore?: McpSessionStore;
  readonly sessionContextValidator?: McpSessionContextValidator;
  readonly tokenVerifier?: McpAccessTokenVerifier;
  readonly revocations?: McpRevocationReader;
  readonly fetchAuthMarkdown?: (authBaseUrl: string) => Promise<string>;
  readonly now?: () => number;
}

export async function handleMcpServerRequest(options: McpServerRequestOptions): Promise<Response> {
  let actor: McpAccessTokenActor | null = null;
  const verifier =
    options.tokenVerifier ??
    makeHttpMcpAccessTokenVerifier({
      issuer: authIssuer(options.authBaseUrl, options.platformTarget),
    });
  const transportResponse = await routeTransportRequest({
    ...options,
    authenticateBearer: async (authorization, audience) => {
      actor = await verifier.verify(
        authorization,
        audience,
        Math.floor((options.now?.() ?? Date.now()) / 1000),
      );
      if (actor && (await requiredRevocations(options.revocations).isRevoked(actor.subject))) {
        actor = null;
      }
      return actor !== null;
    },
  });
  if (transportResponse) return transportResponse;
  if (!actor) throw new Error("mcp-server: authenticated request has no verified actor");

  const request = await readJsonRpcRequest(options.request);
  if (!request.ok) {
    return jsonResponse(request.response, request.status);
  }
  if (request.value.id === undefined && request.value.method.startsWith("notifications/")) {
    return new Response(null, { status: 202, headers: corsHeaders() });
  }

  const controlPlane = createControlPlaneOperationSdk(options);
  const sessionStore = options.sessionStore ?? unconfiguredSessionStore;
  const sessionId = options.request.headers.get("mcp-session-id");
  const response = await dispatch(
    request.value,
    controlPlane,
    actor,
    sessionId,
    sessionStore,
    options,
  );
  const responseSessionId =
    request.value.method === "initialize"
      ? await sessionStore.create(sessionTransportFromActor(actor))
      : undefined;
  return jsonResponse(response, 200, responseSessionId);
}

function requiredRevocations(revocations: McpRevocationReader | undefined): McpRevocationReader {
  if (!revocations) throw new Error("mcp-server: SESSION_STORE revocation binding is required");
  return revocations;
}

async function dispatch(
  request: JsonRpcRequest,
  controlPlane: OperationSdkResolver,
  actor: McpAccessTokenActor,
  sessionId: string | null,
  sessionStore: McpSessionStore,
  options: McpServerRequestOptions,
): Promise<JsonRpcResponse> {
  const id = request.id ?? null;
  if (request.method === "initialize") {
    return jsonRpcResult(id, initializeResult());
  }
  if (request.method === "resources/list") {
    return jsonRpcResult(id, listMcpResources());
  }
  if (request.method === "resources/read") {
    return readMcpResourceRpc(id, request.params, {
      actor,
      sessionId,
      sessionStore,
      authBaseUrl: authIssuer(options.authBaseUrl, options.platformTarget),
      fetchAuthMarkdown: options.fetchAuthMarkdown,
    });
  }
  if (request.method === "prompts/list") {
    return jsonRpcResult(id, listMcpPrompts());
  }
  if (request.method === "prompts/get") {
    return getMcpPromptRpc(id, request.params);
  }
  if (request.method === "tools/list") {
    return jsonRpcResult(id, { tools: MCP_TOOL_DEFINITIONS });
  }
  if (request.method === "tools/call") {
    return callTool(
      id,
      request.params,
      controlPlane,
      actor,
      sessionId,
      sessionStore,
      options.sessionContextValidator,
    );
  }
  return jsonRpcError(id, JSON_RPC_METHOD_NOT_FOUND, "Method not found");
}

async function callTool(
  id: JsonRpcId,
  params: unknown,
  controlPlane: OperationSdkResolver,
  actor: McpAccessTokenActor,
  sessionId: string | null,
  sessionStore: McpSessionStore,
  sessionContextValidator: McpSessionContextValidator | undefined,
): Promise<JsonRpcResponse> {
  const call = parseToolCall(params);
  if (!call || !toolNames.has(call.name)) {
    return jsonRpcError(id, JSON_RPC_METHOD_NOT_FOUND, "Method not found");
  }
  if (call.name === "context_use") {
    try {
      return await contextUse(
        id,
        call.arguments,
        sessionId,
        sessionStore,
        sessionContextValidator ?? controlPlaneContextValidator(controlPlane(), actor),
      );
    } catch (error) {
      return toolCallFailure(id, error);
    }
  }
  const route = getRoute(call.name);
  if (!route) {
    return jsonRpcError(id, JSON_RPC_METHOD_NOT_FOUND, "Method not found");
  }

  try {
    const sdk = controlPlaneSdkForRoute(controlPlane, route);
    const input = await resolveScope(route.path, call.arguments, sessionId, sessionStore);
    if (!input.ok) {
      return jsonRpcResult(id, toolResult({ message: input.message }, { isError: true }));
    }
    const result = await sdk.callOperationById(call.name, input.value, {
      delegation: { subject: actor.subject, scopes: actor.scopes, authDoor: actor.authDoor },
    });
    return jsonRpcResult(
      id,
      result.ok ? toolResult(result.data) : toolResult(result.error, { isError: true }),
    );
  } catch (error) {
    return toolCallFailure(id, error);
  }
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
function toolCallFailure(id: JsonRpcId, error: unknown): JsonRpcResponse {
  if (error instanceof IdempotencyKeyRequiredError) {
    return jsonRpcResult(id, toolResult(error.errorResponse, { isError: true }));
  }
  if (error instanceof McpOperationInvalidParamsError) {
    return jsonRpcError(id, JSON_RPC_INVALID_PARAMS, "Invalid params", {
      argument: error.argument,
      message: error.message,
    });
  }
  return jsonRpcError(id, JSON_RPC_INTERNAL_ERROR, "Internal error", {
    message: error instanceof Error ? error.message : String(error),
  });
}

function authIssuer(configured: string | undefined, platformTarget: string | undefined): string {
  if (configured) return new URL(configured).origin;
  const target = parsePlatformTarget(platformTarget);
  if (target === "local" || target === "pr-ci") return "http://localhost:8791";
  throw new Error(`mcp-server: AUTH_API_ORIGIN is required for ${target}`);
}

function sessionTransportFromActor(actor: McpAccessTokenActor): McpSessionTransport {
  return {
    authDoor: actor.authDoor,
    ...(actor.demoExpiresAt ? { demoExpiresAt: actor.demoExpiresAt } : {}),
  };
}

async function contextUse(
  id: JsonRpcId,
  arguments_: unknown,
  sessionId: string | null,
  sessionStore: McpSessionStore,
  validate: McpSessionContextValidator,
): Promise<JsonRpcResponse> {
  const result = await setSessionContext(arguments_, sessionId, sessionStore, validate);
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

function initializeResult(): Record<string, unknown> {
  return {
    protocolVersion,
    capabilities: {
      tools: { listChanged: false },
      resources: { listChanged: false },
      prompts: { listChanged: false },
    },
    serverInfo: { name: "splitch-mcp-server", version: "0.0.0" },
  };
}

function toolResult(value: unknown, options: { isError?: boolean } = {}): Record<string, unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    ...(options.isError ? { isError: true } : {}),
  };
}

const unconfiguredSessionStore: McpSessionStore = {
  async create() {
    throw new Error("mcp-server: MCP session store is not configured");
  },
  async get() {
    return undefined;
  },
  async getTransport() {
    return undefined;
  },
  async set() {
    throw new Error("mcp-server: MCP session store is not configured");
  },
  async end() {
    throw new Error("mcp-server: MCP session store is not configured");
  },
};
