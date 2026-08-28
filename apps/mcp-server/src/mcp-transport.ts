import { createHealthResponse, parsePlatformTarget } from "@splitch/contracts";
import type { JsonRpcResponse } from "./json-rpc";
import type { McpSessionStore } from "./mcp-session-context";
import { McpSessionNotFoundError } from "./mcp-session-store";

const protectedResourcePath = "/.well-known/oauth-protected-resource";
const defaultAuthBaseUrl = "http://localhost:8791";

export async function routeTransportRequest(options: {
  request: Request;
  service: string;
  deployedCommitSha?: string;
  platformTarget?: string;
  authBaseUrl?: string;
  sessionStore?: McpSessionStore;
  authenticateBearer?: (authorization: string, audience: string) => Promise<string | null>;
}): Promise<Response | undefined> {
  const url = new URL(options.request.url);
  if (isHealthRequest(options.request, url)) {
    return Response.json(
      createHealthResponse(
        options.service,
        parsePlatformTarget(options.platformTarget),
        options.deployedCommitSha,
      ),
    );
  }
  if (options.request.method === "GET" && isProtectedResourcePath(url.pathname)) {
    return protectedResourceResponse(url, options.platformTarget, options.authBaseUrl);
  }
  if (options.request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  const authentication = await authenticateRequest(options, url);
  if (!authentication.ok) return authentication.response;
  if (options.request.method === "DELETE" && isMcpPath(url)) {
    return endSession(options.request, options.sessionStore, authentication.subject);
  }
  if (options.request.method !== "POST" || !isMcpPath(url)) {
    return new Response("not found", { status: 404 });
  }
  return validateSession(options.request, options.sessionStore, authentication.subject);
}

async function authenticateRequest(
  options: {
    request: Request;
    authenticateBearer?: (authorization: string, audience: string) => Promise<string | null>;
  },
  url: URL,
): Promise<{ ok: true; subject?: string } | { ok: false; response: Response }> {
  if (!requiresBearer(options.request, url)) return { ok: true };
  if (!options.authenticateBearer) {
    throw new Error("mcp-server: authenticateBearer is required");
  }
  const authorization = bearerAuthorization(options.request);
  if (!authorization) return { ok: false, response: unauthorizedResponse(url) };
  const subject = await options.authenticateBearer(authorization, protectedResource(url));
  if (!subject) return { ok: false, response: unauthorizedResponse(url) };
  return { ok: true, subject };
}

function requiresBearer(request: Request, url: URL): boolean {
  return isMcpPath(url) && (request.method === "POST" || request.method === "DELETE");
}

function isProtectedResourcePath(pathname: string): boolean {
  const resourcePath = pathname.slice(protectedResourcePath.length);
  return (
    pathname.startsWith(protectedResourcePath) && (resourcePath === "" || resourcePath === "/mcp")
  );
}

function protectedResourceResponse(
  resourceUrl: URL,
  platformTarget: string | undefined,
  configuredAuthBaseUrl: string | undefined,
): Response {
  const authorizationServer = authBaseUrl(configuredAuthBaseUrl, platformTarget);
  const resourcePath = resourceUrl.pathname.slice(protectedResourcePath.length);
  return Response.json(
    {
      resource: `${resourceUrl.origin}${resourcePath}`,
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

function bearerAuthorization(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim().length > 0 ? header : null;
}

function unauthorizedResponse(url: URL): Response {
  const headers = corsHeaders();
  const resourcePath = url.pathname === "/" ? "" : url.pathname;
  headers.set(
    "www-authenticate",
    `Bearer realm="splitch", resource_metadata="${url.origin}${protectedResourcePath}${resourcePath}"`,
  );
  return new Response("Unauthorized", { status: 401, headers });
}

function protectedResource(url: URL): string {
  return url.pathname === "/" ? url.origin : `${url.origin}${url.pathname}`;
}

export function jsonResponse(body: JsonRpcResponse, status = 200, sessionId?: string): Response {
  const headers = corsHeaders();
  if (sessionId) headers.set("mcp-session-id", sessionId);
  return Response.json(body, { status, headers });
}

async function endSession(
  request: Request,
  sessionStore: McpSessionStore | undefined,
  subject: string | undefined,
): Promise<Response> {
  const sessionId = request.headers.get("mcp-session-id");
  if (!sessionId) return new Response("MCP session ID is required", { status: 400 });
  if (!sessionStore) throw new Error("mcp-server: MCP session store is not configured");
  if (!subject) {
    throw new Error("mcp-server: MCP session operations require an authenticated subject");
  }
  // One subject-bound end: a prior get-then-end left a window where expiry or a
  // concurrent DELETE turned the second hop into a generic Error and a 500.
  try {
    await sessionStore.end(sessionId, subject);
  } catch (error) {
    if (error instanceof McpSessionNotFoundError) return deadSessionResponse();
    throw error;
  }
  return new Response(null, { status: 204, headers: corsHeaders() });
}

async function validateSession(
  request: Request,
  sessionStore: McpSessionStore | undefined,
  subject: string | undefined,
): Promise<Response | undefined> {
  const sessionId = request.headers.get("mcp-session-id");
  if (!sessionId) return undefined;
  if (!sessionStore) throw new Error("mcp-server: MCP session store is not configured");
  if (!subject) {
    throw new Error("mcp-server: MCP session operations require an authenticated subject");
  }
  try {
    await sessionStore.get(sessionId, subject);
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
