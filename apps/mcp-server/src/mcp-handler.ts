import { getRoute, parsePlatformTarget, type RouteOwner } from "@splitch/contracts";
import { createMcpOperationAdapter } from "@splitch/control-plane-sdk/mcp-operation-adapter";
import {
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_METHOD_NOT_FOUND,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  jsonRpcError,
  jsonRpcResult,
} from "./json-rpc";
import { readJsonRpcRequest } from "./mcp-request";
import {
  type McpSessionStore,
  parseToolCall,
  resolveScope,
  setSessionContext,
} from "./mcp-session-context";
import { corsHeaders, jsonResponse, routeTransportRequest } from "./mcp-transport";
import { MCP_TOOL_DEFINITIONS } from "./tool-registry";

const protocolVersion = "2025-06-18";
const defaultControlPlaneBaseUrl = "http://127.0.0.1:8787";
const defaultEvaluationBaseUrl = "http://127.0.0.1:8788";
const defaultAnalysisBaseUrl = "http://127.0.0.1:8790";
const internalAnalysisBaseUrl = "https://analysis-api.internal";
const toolNames = new Set(MCP_TOOL_DEFINITIONS.map((tool) => tool.name));
type McpRoutableOwner = "control-plane-api" | "evaluation-api" | "analysis-api";
type OperationSdk = ReturnType<typeof createMcpOperationAdapter>;
type OperationSdkResolver = () => OperationSdk;
type OperationSdks = Record<McpRoutableOwner, OperationSdkResolver>;

export interface McpServerRequestOptions {
  readonly request: Request;
  readonly service: string;
  readonly platformTarget?: string;
  readonly controlPlaneBaseUrl?: string;
  readonly evaluationBaseUrl?: string;
  readonly analysisBaseUrl?: string;
  readonly controlPlaneFetch?: typeof fetch;
  readonly analysisFetch?: typeof fetch;
  readonly sessionStore?: McpSessionStore;
}

export async function handleMcpServerRequest(options: McpServerRequestOptions): Promise<Response> {
  const transportResponse = await routeTransportRequest(options);
  if (transportResponse) return transportResponse;

  const request = await readJsonRpcRequest(options.request);
  if (!request.ok) {
    return jsonResponse(request.response, request.status);
  }
  if (request.value.id === undefined && request.value.method.startsWith("notifications/")) {
    return new Response(null, { status: 202, headers: corsHeaders() });
  }

  const sdks = createOperationSdks(options);
  const sessionStore = options.sessionStore ?? unconfiguredSessionStore;
  const sessionId = options.request.headers.get("mcp-session-id");
  const response = await dispatch(
    request.value,
    sdks,
    options.request.headers.get("authorization"),
    sessionId,
    sessionStore,
  );
  const responseSessionId =
    request.value.method === "initialize" ? await sessionStore.create() : undefined;
  return jsonResponse(response, 200, responseSessionId);
}

function createOperationSdks(options: McpServerRequestOptions): OperationSdks {
  const platformTarget = parsePlatformTarget(options.platformTarget);
  return {
    "control-plane-api": createLazyOperationSdk(() =>
      createMcpOperationAdapter({
        baseUrl: apiBaseUrl(
          "CONTROL_PLANE_API_ORIGIN",
          options.controlPlaneBaseUrl,
          defaultControlPlaneBaseUrl,
          platformTarget,
        ),
        fetch: options.controlPlaneFetch,
      }),
    ),
    "evaluation-api": createLazyOperationSdk(() =>
      createMcpOperationAdapter({
        baseUrl: apiBaseUrl(
          "EVALUATION_API_ORIGIN",
          options.evaluationBaseUrl,
          defaultEvaluationBaseUrl,
          platformTarget,
        ),
        fetch: options.controlPlaneFetch,
      }),
    ),
    "analysis-api": createLazyOperationSdk(() =>
      createMcpOperationAdapter({
        baseUrl: analysisApiBaseUrl(
          options.analysisBaseUrl,
          platformTarget,
          options.analysisFetch !== undefined,
        ),
        fetch: options.analysisFetch ?? options.controlPlaneFetch,
      }),
    ),
  };
}

function createLazyOperationSdk(createSdk: () => OperationSdk): OperationSdkResolver {
  let sdk: OperationSdk | undefined;
  return () => {
    sdk ??= createSdk();
    return sdk;
  };
}

function analysisApiBaseUrl(
  configured: string | undefined,
  platformTarget: string,
  hasServiceBinding: boolean,
): string {
  if (configured) {
    return configured;
  }
  if (platformTarget === "local" || platformTarget === "pr-ci") {
    return defaultAnalysisBaseUrl;
  }
  if (hasServiceBinding) {
    return internalAnalysisBaseUrl;
  }
  throw new Error("mcp-server: ANALYSIS_API service binding is required for hosted targets");
}

function apiBaseUrl(
  envName: string,
  configured: string | undefined,
  localDefault: string,
  platformTarget: string,
): string {
  if (configured) {
    return configured;
  }
  if (platformTarget === "local" || platformTarget === "pr-ci") {
    return localDefault;
  }
  throw new Error(`mcp-server: ${envName} is required for ${platformTarget}`);
}

async function dispatch(
  request: JsonRpcRequest,
  sdks: OperationSdks,
  authorization: string | null,
  sessionId: string | null,
  sessionStore: McpSessionStore,
): Promise<JsonRpcResponse> {
  const id = request.id ?? null;
  if (request.method === "initialize") {
    return jsonRpcResult(id, initializeResult());
  }
  if (request.method === "tools/list") {
    return jsonRpcResult(id, { tools: MCP_TOOL_DEFINITIONS });
  }
  if (request.method === "tools/call") {
    return callTool(id, request.params, sdks, authorization, sessionId, sessionStore);
  }
  return jsonRpcError(id, JSON_RPC_METHOD_NOT_FOUND, "Method not found");
}

async function callTool(
  id: JsonRpcId,
  params: unknown,
  sdks: OperationSdks,
  authorization: string | null,
  sessionId: string | null,
  sessionStore: McpSessionStore,
): Promise<JsonRpcResponse> {
  const call = parseToolCall(params);
  if (!call || !toolNames.has(call.name)) {
    return jsonRpcError(id, JSON_RPC_METHOD_NOT_FOUND, "Method not found");
  }
  if (call.name === "context_use") {
    return contextUse(id, call.arguments, sessionId, sessionStore);
  }
  const route = getRoute(call.name);
  if (!route) {
    return jsonRpcError(id, JSON_RPC_METHOD_NOT_FOUND, "Method not found");
  }

  try {
    const sdk = sdkForOwner(sdks, route.owner);
    const input = await resolveScope(route.path, call.arguments, sessionId, sessionStore);
    if (!input.ok) {
      return jsonRpcResult(id, toolResult({ message: input.message }, { isError: true }));
    }
    const result = await sdk.callOperationById(call.name, input.value, { authorization });
    return jsonRpcResult(
      id,
      result.ok ? toolResult(result.data) : toolResult(result.error, { isError: true }),
    );
  } catch (error) {
    return jsonRpcError(id, JSON_RPC_INTERNAL_ERROR, "Internal error", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function contextUse(
  id: JsonRpcId,
  arguments_: unknown,
  sessionId: string | null,
  sessionStore: McpSessionStore,
): Promise<JsonRpcResponse> {
  const result = await setSessionContext(arguments_, sessionId, sessionStore);
  return jsonRpcResult(
    id,
    result.ok
      ? toolResult(result.value)
      : toolResult({ message: result.message }, { isError: true }),
  );
}

function sdkForOwner(sdks: OperationSdks, owner: RouteOwner): OperationSdk {
  if (owner === "control-plane-api" || owner === "evaluation-api" || owner === "analysis-api") {
    return sdks[owner]();
  }
  throw new Error(`mcp-server: no API origin configured for route owner "${owner}"`);
}

function initializeResult(): Record<string, unknown> {
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
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
  async set() {
    throw new Error("mcp-server: MCP session store is not configured");
  },
  async end() {
    throw new Error("mcp-server: MCP session store is not configured");
  },
};
