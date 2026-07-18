import { createHealthResponse, parsePlatformTarget } from "@splitch/contracts";
import type { JsonRpcResponse } from "./json-rpc";
import type { McpSessionStore } from "./mcp-session-context";

export async function routeTransportRequest(options: {
  request: Request;
  service: string;
  platformTarget?: string;
  sessionStore?: McpSessionStore;
}): Promise<Response | undefined> {
  const url = new URL(options.request.url);
  if (isHealthRequest(options.request, url)) {
    return Response.json(
      createHealthResponse(options.service, parsePlatformTarget(options.platformTarget)),
    );
  }
  if (options.request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (options.request.method === "DELETE" && isMcpPath(url)) {
    return endSession(options.request, options.sessionStore);
  }
  if (options.request.method !== "POST" || !isMcpPath(url)) {
    return new Response("not found", { status: 404 });
  }
  return undefined;
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
  if (!sessionStore) throw new Error("mcp-server: MCP session store is not configured");
  await sessionStore.end(sessionId);
  return new Response(null, { status: 204, headers: corsHeaders() });
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
