import { createHealthResponse, parsePlatformTarget } from "@splitch/contracts";
import type { JsonRpcResponse } from "./json-rpc";
import type { McpSessionStore } from "./mcp-session-context";
import { McpSessionNotFoundError } from "./mcp-session-store";

const protectedResourcePath = "/.well-known/oauth-protected-resource";
const defaultAuthBaseUrl = "http://127.0.0.1:8791";

export async function routeTransportRequest(options: {
  request: Request;
  service: string;
  platformTarget?: string;
  authBaseUrl?: string;
  sessionStore?: McpSessionStore;
}): Promise<Response | undefined> {
  const url = new URL(options.request.url);
  if (isHealthRequest(options.request, url)) {
    return Response.json(
      createHealthResponse(options.service, parsePlatformTarget(options.platformTarget)),
    );
  }
  if (options.request.method === "GET" && url.pathname === protectedResourcePath) {
    return protectedResourceResponse(url, options.platformTarget, options.authBaseUrl);
  }
  if (options.request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (requiresBearer(options.request, url) && !hasBearerToken(options.request)) {
    return unauthorizedResponse(url);
  }
  if (options.request.method === "DELETE" && isMcpPath(url)) {
    return endSession(options.request, options.sessionStore);
  }
  if (options.request.method !== "POST" || !isMcpPath(url)) {
    return new Response("not found", { status: 404 });
  }
  return validateSession(options.request, options.sessionStore);
}

function requiresBearer(request: Request, url: URL): boolean {
  return isMcpPath(url) && (request.method === "POST" || request.method === "DELETE");
}

function protectedResourceResponse(
  resourceUrl: URL,
  platformTarget: string | undefined,
  configuredAuthBaseUrl: string | undefined,
): Response {
  const authorizationServer = authBaseUrl(configuredAuthBaseUrl, platformTarget);
  return Response.json(
    {
      resource: resourceUrl.origin,
      authorization_servers: [authorizationServer],
    },
    { headers: corsHeaders() },
  );
}

function authBaseUrl(configured: string | undefined, platformTarget: string | undefined): string {
  if (configured) return new URL(configured).origin;
  const target = parsePlatformTarget(platformTarget);
  if (target === "local" || target === "pr-ci") return defaultAuthBaseUrl;
  throw new Error(`mcp-server: AUTH_API_ORIGIN is required for ${target}`);
}

function hasBearerToken(request: Request): boolean {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  return header.slice("Bearer ".length).trim().length > 0;
}

function unauthorizedResponse(url: URL): Response {
  const headers = corsHeaders();
  headers.set(
    "www-authenticate",
    `Bearer realm="splitch" resource_metadata_url="${url.origin}${protectedResourcePath}"`,
  );
  return new Response("Unauthorized", { status: 401, headers });
}

export function jsonResponse(body: JsonRpcResponse, status = 200, sessionId?: string): Response {
  const headers = corsHeaders();
  if (sessionId) headers.set("mcp-session-id", sessionId);
  return Response.json(body, { status, headers });
}

async function endSession(
  request: Request,
  sessionStore: McpSessionStore | undefined,
): Promise<Response> {
  const sessionId = request.headers.get("mcp-session-id");
  if (!sessionId) return new Response("MCP session ID is required", { status: 400 });
  const invalidSession = await validateSession(request, sessionStore);
  if (invalidSession) return invalidSession;
  if (!sessionStore) throw new Error("mcp-server: MCP session store is not configured");
  await sessionStore.end(sessionId);
  return new Response(null, { status: 204, headers: corsHeaders() });
}

async function validateSession(
  request: Request,
  sessionStore: McpSessionStore | undefined,
): Promise<Response | undefined> {
  const sessionId = request.headers.get("mcp-session-id");
  if (!sessionId) return undefined;
  if (!sessionStore) throw new Error("mcp-server: MCP session store is not configured");
  try {
    await sessionStore.get(sessionId);
    return undefined;
  } catch (error) {
    if (error instanceof McpSessionNotFoundError) return deadSessionResponse();
    throw error;
  }
}

function deadSessionResponse(): Response {
  return new Response("MCP session not found", { status: 404, headers: corsHeaders() });
}

function isHealthRequest(request: Request, url: URL): boolean {
  return request.method === "GET" && (url.pathname === "/" || url.pathname === "/health");
}

function isMcpPath(url: URL): boolean {
  return url.pathname === "/" || url.pathname === "/mcp";
}

export function corsHeaders(): Headers {
  return new Headers({
    "access-control-allow-headers": "authorization, content-type, mcp-session-id",
    "access-control-allow-methods": "DELETE, GET, POST, OPTIONS",
    "access-control-allow-origin": "*",
  });
}
