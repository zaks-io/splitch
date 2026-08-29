import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ErrorResponse } from "@splitch/contracts";
import { afterEach, vi } from "vitest";
import { flagDefinition, flagPage } from "./mcp-flag-fixtures";
import { handleMcpServerRequest } from "./mcp-handler";
import {
  allowMcpRevocations,
  staticMcpTokenVerifier,
  TEST_MCP_DELEGATION_SECRET,
} from "./mcp-test-verifier";

/**
 * Shared transport harness for the mcp-handler suites. Split from
 * `mcp-handler.test.ts` so that file stays under the file-size ratchet (300
 * code lines); every suite boots the same stub Control Plane over real HTTP.
 */

export const service = "splitch-mcp-server";
const token = "Bearer local-test-token";

const upstreamFlagPage = {
  ...flagPage,
  unexpectedSecretLikeField: "must-not-escape",
};

export const updatedFlag = {
  ...flagDefinition,
  name: "Checkout v2",
  description: "Updated checkout",
  updatedAt: "2026-07-03T01:00:00.000Z",
};

export const validationError: ErrorResponse = {
  code: "VALIDATION_ERROR",
  message: "request failed schema validation",
  details: { issues: [{ path: ["body", "name"], message: "required" }] },
};

let cleanupServers: (() => Promise<void>)[] = [];

export function useMcpServers(): void {
  afterEach(async () => {
    await Promise.all(cleanupServers.map((cleanup) => cleanup()));
    cleanupServers = [];
    vi.restoreAllMocks();
  });
}

export interface SeenRequest {
  method: string;
  path: string;
  authorization: string | null;
  body: string;
}

export interface JsonRpcSuccess<T> {
  result: T;
}

export interface JsonRpcFailure {
  error: { code: number; message: string };
}

export interface ProtocolTool {
  name: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolResult<T> {
  structuredContent: T;
  isError?: boolean;
}

export function toolsListRequest(): Request {
  return new Request("https://mcp.test/mcp", {
    method: "POST",
    headers: { authorization: token, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

export async function mcp(
  method: string,
  params?: unknown,
  baseUrls: {
    controlPlaneBaseUrl?: string;
    sessionId?: string;
    authorization?: string;
  } = {},
): Promise<Response> {
  const { sessionId, authorization = token, ...origins } = baseUrls;
  return handleMcpServerRequest({
    request: new Request("https://mcp.test/mcp", {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    service,
    platformTarget: "local",
    tokenVerifier: staticMcpTokenVerifier(),
    revocations: allowMcpRevocations(),
    controlPlaneDelegationSecret: TEST_MCP_DELEGATION_SECRET,
    controlPlaneFetch: origins.controlPlaneBaseUrl ? fetch : undefined,
    ...origins,
  });
}

export async function bootControlPlaneApi(seen: SeenRequest[]): Promise<string> {
  const server = createServer((request, response) => {
    void handleControlPlaneRequest(request, response, seen);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanupServers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function handleControlPlaneRequest(
  request: IncomingMessage,
  response: ServerResponse,
  seen: SeenRequest[],
): Promise<void> {
  const body = await readRequestBody(request);
  seen.push({
    method: request.method ?? "",
    path: request.url ?? "",
    authorization: request.headers.authorization ?? null,
    body,
  });

  const mockResponse = controlPlaneResponse(request);
  writeJson(response, mockResponse.status, mockResponse.body);
}

const exactControlPlaneResponses = new Map<string, { status: number; body: unknown }>([
  ["GET /apps/app_local/flags?include=config", { status: 200, body: upstreamFlagPage }],
  [
    "GET /apps/app_unhydrated/flags?include=config",
    { status: 200, body: { ...upstreamFlagPage, items: [flagDefinition] } },
  ],
  [
    "GET /apps/app_local/flags?include=config&envs=env_dev",
    { status: 200, body: upstreamFlagPage },
  ],
  [
    "GET /apps/app_local/flags?environmentId=env_dev",
    { status: 200, body: { ...upstreamFlagPage, items: [flagDefinition] } },
  ],
  ["PATCH /apps/app_local/flags/flag_checkout", { status: 200, body: updatedFlag }],
  ["POST /apps/app_local/flags", { status: 400, body: validationError }],
]);

function controlPlaneResponse(request: IncomingMessage): { status: number; body: unknown } {
  const exactResponse = exactControlPlaneResponses.get(`${request.method} ${request.url}`);
  if (exactResponse) {
    return exactResponse;
  }
  if (
    request.method === "GET" &&
    /^\/apps\/[^/]+\/envs\/[^/]+\/experiments$/.test(request.url ?? "")
  ) {
    return {
      status: 200,
      body: { items: [], readLimit: 200, readTruncated: false, cursor: null },
    };
  }
  return { status: 404, body: { code: "FLAG_NOT_FOUND", message: "not found", details: {} } };
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
