import { isLocalPlatformTarget, requirePlatformTarget } from "@splitch/contracts";
import { type McpSpanRecorder, noopMcpSpanRecorder } from "@splitch/observability/mcp-spans";
import {
  JSON_RPC_METHOD_NOT_FOUND,
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
import { localMcpFaultReporter, type McpFaultReporter } from "./mcp-fault";
import { createControlPlaneOperationSdk, type OperationSdkResolver } from "./mcp-operation-sdks";
import { PROMPT_DEFINITIONS } from "./mcp-prompt-types";
import { getMcpPromptRpc, listMcpPrompts } from "./mcp-prompts";
import { readJsonRpcRequest } from "./mcp-request";
import { listMcpResources, MCP_RESOURCE_URIS, readMcpResourceRpc } from "./mcp-resources";
import { createBoundSession, unconfiguredSessionStore } from "./mcp-session-binding";
import {
  type McpSessionContextValidator,
  type McpSessionStore,
  parseToolCall,
} from "./mcp-session-context";
import { callTool, type McpToolCallFault } from "./mcp-tool-call";
import { corsHeaders, jsonResponse, routeTransportRequest } from "./mcp-transport";
import { MCP_TOOL_DEFINITIONS } from "./tool-registry";

const protocolVersion = "2025-06-18";

const TOOL_NAMES: ReadonlySet<string> = new Set(MCP_TOOL_DEFINITIONS.map((tool) => tool.name));
const RESOURCE_URIS: ReadonlySet<string> = new Set(MCP_RESOURCE_URIS);
const PROMPT_NAMES: ReadonlySet<string> = new Set(PROMPT_DEFINITIONS.map((prompt) => prompt.name));

export interface McpRevocationReader {
  isRevoked(subject: string): Promise<boolean>;
}

export interface McpServerRequestOptions {
  readonly request: Request;
  readonly service: string;
  readonly deployedCommitSha?: string;
  readonly platformTarget?: string;
  readonly authBaseUrl?: string;
  readonly oauthAuthorizationServer?: string;
  readonly oauthJwksUrl?: string;
  readonly controlPlaneBaseUrl?: string;
  readonly controlPlaneFetch?: typeof fetch;
  readonly controlPlaneDelegationSecret?: string;
  readonly sessionStore?: McpSessionStore;
  readonly sessionContextValidator?: McpSessionContextValidator;
  readonly tokenVerifier?: McpAccessTokenVerifier;
  readonly revocations?: McpRevocationReader;
  readonly fetchAuthMarkdown?: (authBaseUrl: string) => Promise<string>;
  readonly now?: () => number;
  readonly spans?: McpSpanRecorder;
  readonly reportFault?: McpFaultReporter;
}

export async function handleMcpServerRequest(options: McpServerRequestOptions): Promise<Response> {
  let actor: McpAccessTokenActor | null = null;
  const verifier = options.tokenVerifier ?? defaultTokenVerifier(options);
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
      return actor?.subject ?? null;
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
    options.reportFault ?? localMcpFaultReporter(),
  );
  const responseSessionId =
    request.value.method === "initialize"
      ? await createBoundSession(sessionStore, actor)
      : undefined;
  return jsonResponse(response, 200, responseSessionId);
}

function defaultTokenVerifier(options: McpServerRequestOptions): McpAccessTokenVerifier {
  const issuer = authIssuer(
    options.oauthAuthorizationServer ?? options.authBaseUrl,
    options.platformTarget,
  );
  if (!options.oauthAuthorizationServer) {
    return makeHttpMcpAccessTokenVerifier({ issuer });
  }
  return makeHttpMcpAccessTokenVerifier({
    issuer,
    profile: "authkit",
    ...(options.oauthJwksUrl ? { jwksUrl: options.oauthJwksUrl } : {}),
  });
}

function requiredRevocations(revocations: McpRevocationReader | undefined): McpRevocationReader {
  if (!revocations) throw new Error("mcp-server: SESSION_STORE revocation binding is required");
  return revocations;
}

/**
 * Every MCP method gets a span, not just `tools/call`. From an agent's side
 * `resources/read` and `prompts/get` are the same kind of call and fail the same
 * ways, and the span costs one wrapper either way -- instrumenting only tools
 * would leave two thirds of the protocol surface as an undifferentiated
 * `POST /mcp`.
 *
 * The subject (tool name, resource URI, prompt name) is resolved BEFORE dispatch
 * so a span exists even for a call that then fails validation. `spanSubject`
 * resolves it against a contract-derived closed set, so span names stay bounded
 * in cardinality and carry no caller text.
 */
async function dispatch(
  request: JsonRpcRequest,
  controlPlane: OperationSdkResolver,
  actor: McpAccessTokenActor,
  sessionId: string | null,
  sessionStore: McpSessionStore,
  options: McpServerRequestOptions,
  reportFault: McpFaultReporter,
): Promise<JsonRpcResponse> {
  const spans = options.spans ?? noopMcpSpanRecorder;
  return spans.record(
    { method: request.method, subject: spanSubject(request), sessionId },
    (span) =>
      dispatchMethod(request, controlPlane, actor, sessionId, sessionStore, options, {
        reportFault,
        span,
      }),
  );
}

/**
 * The JSON-RPC id is deliberately NOT a span attribute. Sentry lists
 * `mcp.request.id` as optional, and ours is caller-chosen: it is both an
 * unbounded-cardinality tag and a channel a client could use to write arbitrary
 * text into our span payloads.
 *
 * The subject is the same channel, so it is resolved against the registry it
 * names instead of being read off the wire. `params.uri` and `params.name` are
 * unvalidated caller strings at this point -- taken verbatim they would carry a
 * Targeting Key straight into an allow-listed `mcp.resource.uri` attribute, and
 * give the span name unbounded cardinality besides. An unrecognised subject
 * yields `undefined`, so the call still gets a span named after its method alone.
 */
function spanSubject(request: JsonRpcRequest): string | undefined {
  if (request.method === "tools/call") {
    return knownSubject(TOOL_NAMES, parseToolCall(request.params)?.name);
  }
  if (request.method === "resources/read") {
    return knownSubject(RESOURCE_URIS, stringParam(request.params, "uri"));
  }
  if (request.method === "prompts/get") {
    return knownSubject(PROMPT_NAMES, stringParam(request.params, "name"));
  }
  return undefined;
}

function knownSubject(known: ReadonlySet<string>, subject: string | undefined): string | undefined {
  return subject !== undefined && known.has(subject) ? subject : undefined;
}

function stringParam(params: unknown, key: string): string | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const value = (params as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function dispatchMethod(
  request: JsonRpcRequest,
  controlPlane: OperationSdkResolver,
  actor: McpAccessTokenActor,
  sessionId: string | null,
  sessionStore: McpSessionStore,
  options: McpServerRequestOptions,
  fault: McpToolCallFault,
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
      reportFault: fault.reportFault,
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
      fault,
    );
  }
  return jsonRpcError(id, JSON_RPC_METHOD_NOT_FOUND, "Method not found");
}

function authIssuer(configured: string | undefined, platformTarget: string | undefined): string {
  const target = requirePlatformTarget(platformTarget);
  if (configured) return new URL(configured).origin;
  if (isLocalPlatformTarget(target)) return "http://localhost:8791";
  throw new Error(`mcp-server: AUTH_API_ORIGIN is required for ${target}`);
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
