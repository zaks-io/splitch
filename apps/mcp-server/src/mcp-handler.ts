import { createControlPlaneSdk } from "@splitch/control-plane-sdk";
import {
  createHealthResponse,
  deriveMcpProtocolTools,
  getRoute,
  parsePlatformTarget,
  type RouteOwner,
} from "@splitch/contracts";
import {
  isJsonRpcRequest,
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  jsonRpcError,
  jsonRpcResult,
} from "./json-rpc";

const protocolVersion = "2025-06-18";
const defaultControlPlaneBaseUrl = "http://127.0.0.1:8787";
const defaultEvaluationBaseUrl = "http://127.0.0.1:8788";
const defaultAnalysisBaseUrl = "http://127.0.0.1:8790";
const tools = deriveMcpProtocolTools();
const toolNames = new Set(tools.map((tool) => tool.name));
type McpRoutableOwner = "control-plane-api" | "evaluation-api" | "analysis-api";
type OperationSdk = ReturnType<typeof createControlPlaneSdk>;
type OperationSdks = Record<McpRoutableOwner, OperationSdk>;

export interface McpServerRequestOptions {
  readonly request: Request;
  readonly service: string;
  readonly platformTarget?: string;
  readonly controlPlaneBaseUrl?: string;
  readonly evaluationBaseUrl?: string;
  readonly analysisBaseUrl?: string;
  readonly controlPlaneFetch?: typeof fetch;
}

export async function handleMcpServerRequest(options: McpServerRequestOptions): Promise<Response> {
  const url = new URL(options.request.url);
  if (isHealthRequest(options.request, url)) {
    return Response.json(
      createHealthResponse(options.service, parsePlatformTarget(options.platformTarget)),
    );
  }
  if (options.request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (options.request.method !== "POST" || !isMcpPath(url)) {
    return new Response("not found", { status: 404 });
  }

  const request = await readJsonRpcRequest(options.request);
  if (!request.ok) {
    return jsonResponse(request.response, request.status);
  }
  if (request.value.id === undefined && request.value.method.startsWith("notifications/")) {
    return new Response(null, { status: 202, headers: corsHeaders() });
  }

  const sdks = createOperationSdks(options);
  const response = await dispatch(
    request.value,
    sdks,
    options.request.headers.get("authorization"),
  );
  return jsonResponse(response);
}

function createOperationSdks(options: McpServerRequestOptions): OperationSdks {
  const platformTarget = parsePlatformTarget(options.platformTarget);
  return {
    "control-plane-api": createControlPlaneSdk({
      baseUrl: apiBaseUrl(
        "CONTROL_PLANE_API_ORIGIN",
        options.controlPlaneBaseUrl,
        defaultControlPlaneBaseUrl,
        platformTarget,
      ),
      fetch: options.controlPlaneFetch,
    }),
    "evaluation-api": createControlPlaneSdk({
      baseUrl: apiBaseUrl(
        "EVALUATION_API_ORIGIN",
        options.evaluationBaseUrl,
        defaultEvaluationBaseUrl,
        platformTarget,
      ),
      fetch: options.controlPlaneFetch,
    }),
    "analysis-api": createControlPlaneSdk({
      baseUrl: apiBaseUrl(
        "ANALYSIS_API_ORIGIN",
        options.analysisBaseUrl,
        defaultAnalysisBaseUrl,
        platformTarget,
      ),
      fetch: options.controlPlaneFetch,
    }),
  };
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

function isHealthRequest(request: Request, url: URL): boolean {
  return request.method === "GET" && (url.pathname === "/" || url.pathname === "/health");
}

function isMcpPath(url: URL): boolean {
  return url.pathname === "/" || url.pathname === "/mcp";
}

async function readJsonRpcRequest(
  request: Request,
): Promise<
  { ok: true; value: JsonRpcRequest } | { ok: false; status: number; response: JsonRpcResponse }
> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return {
      ok: false,
      status: 400,
      response: jsonRpcError(null, JSON_RPC_PARSE_ERROR, "Parse error"),
    };
  }
  if (!isJsonRpcRequest(body)) {
    return {
      ok: false,
      status: 400,
      response: jsonRpcError(null, JSON_RPC_INVALID_REQUEST, "Invalid Request"),
    };
  }
  return { ok: true, value: body };
}

async function dispatch(
  request: JsonRpcRequest,
  sdks: OperationSdks,
  authorization: string | null,
): Promise<JsonRpcResponse> {
  const id = request.id ?? null;
  if (request.method === "initialize") {
    return jsonRpcResult(id, initializeResult());
  }
  if (request.method === "tools/list") {
    return jsonRpcResult(id, { tools });
  }
  if (request.method === "tools/call") {
    return callTool(id, request.params, sdks, authorization);
  }
  return jsonRpcError(id, JSON_RPC_METHOD_NOT_FOUND, "Method not found");
}

async function callTool(
  id: JsonRpcId,
  params: unknown,
  sdks: OperationSdks,
  authorization: string | null,
): Promise<JsonRpcResponse> {
  const call = parseToolCall(params);
  if (!call || !toolNames.has(call.name)) {
    return jsonRpcError(id, JSON_RPC_METHOD_NOT_FOUND, "Method not found");
  }
  const route = getRoute(call.name);
  if (!route) {
    return jsonRpcError(id, JSON_RPC_METHOD_NOT_FOUND, "Method not found");
  }

  try {
    const sdk = sdkForOwner(sdks, route.owner);
    const result = await sdk.callOperation(call.name, call.arguments, { authorization });
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

function sdkForOwner(sdks: OperationSdks, owner: RouteOwner): OperationSdk {
  if (owner === "control-plane-api" || owner === "evaluation-api" || owner === "analysis-api") {
    return sdks[owner];
  }
  throw new Error(`mcp-server: no API origin configured for route owner "${owner}"`);
}

function parseToolCall(params: unknown): { name: string; arguments: unknown } | null {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return null;
  }
  const call = params as { name?: unknown; arguments?: unknown };
  return typeof call.name === "string"
    ? { name: call.name, arguments: call.arguments ?? {} }
    : null;
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

function jsonResponse(body: JsonRpcResponse, status = 200): Response {
  return Response.json(body, { status, headers: corsHeaders() });
}

function corsHeaders(): Headers {
  return new Headers({
    "access-control-allow-headers": "authorization, content-type, mcp-session-id",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-origin": "*",
  });
}
