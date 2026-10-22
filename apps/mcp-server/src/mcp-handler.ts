import { isLocalPlatformTarget, requirePlatformTarget } from "@splitch/contracts";
import { type McpSpanRecorder, noopMcpSpanRecorder } from "@splitch/observability/mcp-spans";
import {
  noopPerformanceSpanRecorder,
  type PerformanceSpanRecorder,
} from "@splitch/observability/performance-spans";
import { canonicalizeMcpClientName } from "@splitch/privacy";
import {
  JSON_RPC_METHOD_NOT_FOUND,
  type JsonRpcRequest,
  type JsonRpcResponse,
  jsonRpcError,
  jsonRpcResult,
} from "./json-rpc";
import {
  delegationActor,
  type McpAccessTokenActor,
  type McpAccessTokenVerifier,
  makeHttpMcpAccessTokenVerifier,
} from "./mcp-access-token";
import { authenticateMcpBearer } from "./mcp-authentication";
import type { McpEffectiveAuthority } from "./mcp-capabilities";
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
import { instrumentMcpSessionStore } from "./mcp-session-spans";
import { callTool, type McpToolCallFault } from "./mcp-tool-call";
import { withToolCallResultMeta } from "./mcp-tool-result-meta";
import { corsHeaders, jsonResponse, routeTransportRequest } from "./mcp-transport";
import { MCP_TOOL_NAMES, mcpToolDefinitions } from "./tool-registry";

const protocolVersion = "2025-06-18";

const RESOURCE_URIS: ReadonlySet<string> = new Set(MCP_RESOURCE_URIS);
const PROMPT_NAMES: ReadonlySet<string> = new Set(PROMPT_DEFINITIONS.map((prompt) => prompt.name));

export interface McpRevocationReader {
  isRevoked(subject: string, issuedAtSeconds: number | undefined): Promise<boolean>;
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
  /** SESSION_STORE: Personal Access Token entries written by the Control Plane. */
  readonly personalAccessTokens?: Pick<KVNamespace, "get">;
  readonly fetchAuthMarkdown?: (authBaseUrl: string) => Promise<string>;
  readonly now?: () => number;
  readonly spans?: McpSpanRecorder;
  readonly performanceSpans?: PerformanceSpanRecorder;
  readonly reportFault?: McpFaultReporter;
}

export async function handleMcpServerRequest(options: McpServerRequestOptions): Promise<Response> {
  let actor: McpAccessTokenActor | null = null;
  const performanceSpans = options.performanceSpans ?? noopPerformanceSpanRecorder;
  const sessionStore = options.sessionStore
    ? instrumentMcpSessionStore(options.sessionStore, performanceSpans)
    : undefined;
  const verifier = options.tokenVerifier ?? defaultTokenVerifier(options);
  const transportResponse = await routeTransportRequest({
    ...options,
    sessionStore,
    authenticateBearer: async (authorization, audience) => {
      const result = await authenticateMcpBearer(options, verifier, authorization, audience);
      if (result && !("refused" in result)) {
        actor = result;
        return actor.subject;
      }
      return result;
    },
  });
  if (transportResponse) return transportResponse;
  if (!actor) throw new Error("mcp-server: authenticated request has no verified actor");

  const request = await performanceSpans.record(
    { name: "mcp.request.parse", op: "serialize" },
    () => readJsonRpcRequest(options.request),
  );
  if (!request.ok) {
    return jsonResponse(request.response, request.status);
  }
  if (request.value.id === undefined && request.value.method.startsWith("notifications/")) {
    return new Response(null, { status: 202, headers: corsHeaders() });
  }

  const controlPlane = createControlPlaneOperationSdk(options);
  const sessionId = options.request.headers.get("mcp-session-id");
  const verifiedActor = actor;
  const protocolSessionStore = sessionStore ?? unconfiguredSessionStore;
  return (options.spans ?? noopMcpSpanRecorder).record(
    {
      method: request.value.method,
      subject: spanSubject(request.value),
      clientName: initializeClientName(request.value),
    },
    async (span) => {
      const response = await dispatchMethod(
        request.value,
        controlPlane,
        verifiedActor,
        sessionId,
        protocolSessionStore,
        options,
        {
          reportFault: options.reportFault ?? localMcpFaultReporter(),
          span,
        },
      );
      const responseSessionId =
        request.value.method === "initialize"
          ? await createBoundSession(protocolSessionStore, verifiedActor)
          : undefined;
      return jsonResponse(response, 200, responseSessionId);
    },
  );
}

export function defaultTokenVerifier(
  options: Pick<
    McpServerRequestOptions,
    "authBaseUrl" | "oauthAuthorizationServer" | "oauthJwksUrl" | "platformTarget"
  >,
): McpAccessTokenVerifier {
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

function initializeClientName(request: JsonRpcRequest): string | undefined {
  if (
    request.method !== "initialize" ||
    typeof request.params !== "object" ||
    request.params === null
  )
    return undefined;
  const clientInfo = (request.params as Record<string, unknown>).clientInfo;
  if (typeof clientInfo !== "object" || clientInfo === null) return undefined;
  const name = (clientInfo as Record<string, unknown>).name;
  return typeof name === "string" ? canonicalizeMcpClientName(name) : undefined;
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
    return knownSubject(MCP_TOOL_NAMES, parseToolCall(request.params)?.name);
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
      resolveCapabilities: () => resolveCapabilities(controlPlane, actor),
    });
  }
  if (request.method === "prompts/list") {
    return jsonRpcResult(id, listMcpPrompts());
  }
  if (request.method === "prompts/get") {
    return getMcpPromptRpc(id, request.params);
  }
  if (request.method === "tools/list") {
    return jsonRpcResult(id, { tools: mcpToolDefinitions() });
  }
  if (request.method === "tools/call") {
    return withToolCallResultMeta(
      await callTool(
        id,
        request.params,
        controlPlane,
        actor,
        sessionId,
        sessionStore,
        options.sessionContextValidator,
        fault,
      ),
      request.params,
    );
  }
  return jsonRpcError(id, JSON_RPC_METHOD_NOT_FOUND, "Method not found");
}

async function resolveCapabilities(
  controlPlane: OperationSdkResolver,
  actor: McpAccessTokenActor,
): Promise<McpEffectiveAuthority> {
  const result = await controlPlane().callOperationById(
    "principal_capabilities_get",
    {},
    { delegation: delegationActor(actor) },
  );
  if (!result.ok) {
    throw new Error(`mcp-server: capability resolution failed with ${result.error.code}`);
  }
  return result.data as McpEffectiveAuthority;
}

export function authIssuer(
  configured: string | undefined,
  platformTarget: string | undefined,
): string {
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
