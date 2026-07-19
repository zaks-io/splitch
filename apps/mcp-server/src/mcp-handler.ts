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
import {
  type McpAccessTokenActor,
  type McpAccessTokenVerifier,
  makeHttpMcpAccessTokenVerifier,
} from "./mcp-access-token";
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
const defaultControlPlaneBaseUrl = "http://localhost:8787";
const defaultEvaluationBaseUrl = "http://127.0.0.1:8788";
const defaultAnalysisBaseUrl = "http://127.0.0.1:8790";
const internalAnalysisBaseUrl = "https://analysis-api.internal";
const toolNames = new Set(MCP_TOOL_DEFINITIONS.map((tool) => tool.name));
type McpRoutableOwner = "control-plane-api" | "evaluation-api" | "analysis-api";
type OperationSdk = ReturnType<typeof createMcpOperationAdapter>;
type OperationSdkResolver = () => OperationSdk;
type OperationSdks = Record<McpRoutableOwner, OperationSdkResolver>;

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
  readonly evaluationBaseUrl?: string;
  readonly analysisBaseUrl?: string;
  readonly controlPlaneFetch?: typeof fetch;
  readonly evaluationFetch?: typeof fetch;
  readonly analysisFetch?: typeof fetch;
  readonly controlPlaneDelegationSecret?: string;
  readonly evaluationDelegationSecret?: string;
  readonly analysisDelegationSecret?: string;
  readonly sessionStore?: McpSessionStore;
  readonly tokenVerifier?: McpAccessTokenVerifier;
  readonly revocations?: McpRevocationReader;
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

  const sdks = createOperationSdks(options);
  const sessionStore = options.sessionStore ?? unconfiguredSessionStore;
  const sessionId = options.request.headers.get("mcp-session-id");
  const response = await dispatch(request.value, sdks, actor, sessionId, sessionStore);
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
        fetch: downstreamFetch("CONTROL_PLANE_API", options.controlPlaneFetch),
        delegationSecret: requiredDelegationSecret(
          "CONTROL_PLANE_API",
          options.controlPlaneDelegationSecret,
        ),
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
        fetch: downstreamFetch("EVALUATION_API", options.evaluationFetch),
        delegationSecret: requiredDelegationSecret(
          "EVALUATION_API",
          options.evaluationDelegationSecret,
        ),
      }),
    ),
    "analysis-api": createLazyOperationSdk(() =>
      createMcpOperationAdapter({
        baseUrl: analysisApiBaseUrl(options.analysisBaseUrl, platformTarget),
        fetch: downstreamFetch("ANALYSIS_API", options.analysisFetch),
        delegationSecret: requiredDelegationSecret(
          "ANALYSIS_API",
          options.analysisDelegationSecret,
        ),
      }),
    ),
  };
}

function requiredDelegationSecret(bindingName: string, secret: string | undefined): string {
  if (!secret) throw new Error(`mcp-server: ${bindingName} delegation secret is required`);
  return secret;
}

function requiredRevocations(revocations: McpRevocationReader | undefined): McpRevocationReader {
  if (!revocations) throw new Error("mcp-server: SESSION_STORE revocation binding is required");
  return revocations;
}

function createLazyOperationSdk(createSdk: () => OperationSdk): OperationSdkResolver {
  let sdk: OperationSdk | undefined;
  return () => {
    sdk ??= createSdk();
    return sdk;
  };
}

function analysisApiBaseUrl(configured: string | undefined, platformTarget: string): string {
  if (configured) {
    return configured;
  }
  if (platformTarget === "local" || platformTarget === "pr-ci") {
    return defaultAnalysisBaseUrl;
  }
  return internalAnalysisBaseUrl;
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

function downstreamFetch(
  bindingName: string,
  requestFetch: typeof fetch | undefined,
): typeof fetch {
  if (!requestFetch) throw new Error(`mcp-server: ${bindingName} service binding is required`);
  return requestFetch;
}

async function dispatch(
  request: JsonRpcRequest,
  sdks: OperationSdks,
  actor: McpAccessTokenActor,
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
    return callTool(id, request.params, sdks, actor, sessionId, sessionStore);
  }
  return jsonRpcError(id, JSON_RPC_METHOD_NOT_FOUND, "Method not found");
}

async function callTool(
  id: JsonRpcId,
  params: unknown,
  sdks: OperationSdks,
  actor: McpAccessTokenActor,
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
    const result = await sdk.callOperationById(call.name, input.value, {
      delegation: { subject: actor.subject, scopes: actor.scopes },
    });
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

function authIssuer(configured: string | undefined, platformTarget: string | undefined): string {
  if (configured) return new URL(configured).origin;
  const target = parsePlatformTarget(platformTarget);
  if (target === "local" || target === "pr-ci") return "http://localhost:8791";
  throw new Error(`mcp-server: AUTH_API_ORIGIN is required for ${target}`);
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
