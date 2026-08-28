import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { deriveMcpProtocolTools, type ErrorResponse } from "@splitch/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flagPage } from "./mcp-flag-fixtures";
import { handleMcpServerRequest } from "./mcp-handler";
import {
  allowMcpRevocations,
  staticMcpTokenVerifier,
  TEST_MCP_DELEGATION_SECRET,
} from "./mcp-test-verifier";

const service = "splitch-mcp-server";
const token = "Bearer local-test-token";

const upstreamFlagPage = {
  ...flagPage,
  unexpectedSecretLikeField: "must-not-escape",
};

const updatedFlag = {
  ...flagPage.items[0],
  name: "Checkout v2",
  description: "Updated checkout",
  updatedAt: "2026-07-03T01:00:00.000Z",
};

const validationError: ErrorResponse = {
  code: "VALIDATION_ERROR",
  message: "request failed schema validation",
  details: { issues: [{ path: ["body", "name"], message: "required" }] },
};

let cleanupServers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanupServers.map((cleanup) => cleanup()));
  cleanupServers = [];
  vi.restoreAllMocks();
});

describe("mcp server Streamable HTTP transport", () => {
  it("lists the full S08-derived tool contract", async () => {
    const response = await mcp("tools/list");
    const body = (await response.json()) as JsonRpcSuccess<{ tools: unknown[] }>;

    expect(response.status).toBe(200);
    expect(body.result.tools).toHaveLength(deriveMcpProtocolTools().length + 1);
    expect(body.result.tools).toContainEqual(
      expect.objectContaining({
        name: "flags_list",
        inputSchema: expect.objectContaining({ type: "object" }),
      }),
    );
    expect(body.result.tools).toContainEqual(
      expect.objectContaining({ name: "context_use", inputSchema: expect.any(Object) }),
    );
  });

  it("forwards flags_list through the Control Plane SDK to a local HTTP API", async () => {
    const seen: SeenRequest[] = [];
    const baseUrl = await bootControlPlaneApi(seen);
    const response = await mcp(
      "tools/call",
      { name: "flags_list", arguments: { appId: "app_local" } },
      { controlPlaneBaseUrl: baseUrl },
    );
    const body = (await response.json()) as JsonRpcSuccess<ToolResult<typeof flagPage>>;

    expect(seen).toEqual([
      {
        method: "GET",
        path: "/apps/app_local/flags",
        authorization: null,
        body: "",
      },
    ]);
    expect(body.result.structuredContent).toEqual(flagPage);
    expect(body.result.structuredContent).not.toHaveProperty("unexpectedSecretLikeField");
  });

  it("advertises and forwards flags_update with path params and body fields", async () => {
    const listResponse = await mcp("tools/list");
    const listBody = (await listResponse.json()) as JsonRpcSuccess<{ tools: ProtocolTool[] }>;
    const updateTool = listBody.result.tools.find((tool) => tool.name === "flags_update");

    expect(updateTool?.inputSchema).toMatchObject({
      properties: expect.objectContaining({
        appId: expect.any(Object),
        flagId: expect.any(Object),
        name: expect.any(Object),
        description: expect.any(Object),
      }),
      required: expect.arrayContaining(["appId", "flagId"]),
    });

    const seen: SeenRequest[] = [];
    const baseUrl = await bootControlPlaneApi(seen);
    const response = await mcp(
      "tools/call",
      {
        name: "flags_update",
        arguments: {
          appId: "app_local",
          flagId: "flag_checkout",
          name: "Checkout v2",
          description: "Updated checkout",
        },
      },
      { controlPlaneBaseUrl: baseUrl },
    );
    const body = (await response.json()) as JsonRpcSuccess<ToolResult<typeof updatedFlag>>;

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: "PATCH",
      path: "/apps/app_local/flags/flag_checkout",
      authorization: null,
    });
    expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({
      name: "Checkout v2",
      description: "Updated checkout",
    });
    expect(body.result.structuredContent).toEqual(updatedFlag);
  });
});

describe("mcp server errors and config", () => {
  it("fails closed when shared revocation state is missing or unavailable", async () => {
    const options = {
      service,
      platformTarget: "local",
      tokenVerifier: staticMcpTokenVerifier(),
      controlPlaneDelegationSecret: TEST_MCP_DELEGATION_SECRET,
    };

    await expect(
      handleMcpServerRequest({ ...options, request: toolsListRequest() }),
    ).rejects.toThrow("mcp-server: SESSION_STORE revocation binding is required");
    await expect(
      handleMcpServerRequest({
        ...options,
        request: toolsListRequest(),
        revocations: {
          isRevoked: async () => {
            throw new Error("revocation KV unavailable");
          },
        },
      }),
    ).rejects.toThrow("revocation KV unavailable");
  });

  it("fails closed without a local named service binding instead of using public HTTP", async () => {
    const logged: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    const response = await mcp("tools/call", {
      name: "flags_list",
      arguments: { appId: "app_local" },
    });
    const body = (await response.json()) as JsonRpcFailure & {
      error: { code: number; message: string; data?: { message?: string; reference?: string } };
    };

    expect(body.error).toMatchObject({ code: -32603 });
    // Loud where an operator reads it, opaque where the agent does.
    expect(JSON.stringify(logged[0]?.[0])).toContain(
      "CONTROL_PLANE_API service binding is required",
    );
    expect(body.error.data?.message).not.toContain("CONTROL_PLANE_API");
    expect(body.error.data?.reference).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns MCP method-not-found for an unknown tool name", async () => {
    const response = await mcp("tools/call", { name: "missing_tool", arguments: {} });
    const body = (await response.json()) as JsonRpcFailure;

    expect(response.status).toBe(200);
    expect(body.error).toMatchObject({ code: -32601, message: "Method not found" });
  });

  it("returns upstream ErrorResponse as a tool error when the Worker rejects Zod body", async () => {
    const seen: SeenRequest[] = [];
    const baseUrl = await bootControlPlaneApi(seen);
    // Valid idempotency key, deliberately invalid `variants`: the Worker's body
    // rejection is what this asserts, not the adapter's own key check.
    const args = { appId: "app_local", key: "checkout", schema: null, variants: [] };
    const response = await mcp(
      "tools/call",
      { name: "flags_create", arguments: { ...args, idempotency_key: "idem_probe" } },
      { controlPlaneBaseUrl: baseUrl },
    );
    const body = (await response.json()) as JsonRpcSuccess<ToolResult<ErrorResponse>>;

    expect(seen[0]).toMatchObject({ method: "POST", path: "/apps/app_local/flags" });
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent).toEqual(validationError);
  });

  it("keeps wrangler state limited to sessions and shared token revocation", async () => {
    const config = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");

    expect(config).not.toMatch(/d1_databases/i);
    expect(config).not.toMatch(/tinybird|analytics_engine_datasets/i);
    expect(config.match(/"name": "MCP_SESSIONS"/g)).toHaveLength(3);
    expect(config.match(/"class_name": "McpSessionDurableObject"/g)).toHaveLength(3);
    expect(config.match(/"binding": "SESSION_STORE"/g)).toHaveLength(3);
  });
});

interface SeenRequest {
  method: string;
  path: string;
  authorization: string | null;
  body: string;
}

interface JsonRpcSuccess<T> {
  result: T;
}

interface JsonRpcFailure {
  error: { code: number; message: string };
}

interface ProtocolTool {
  name: string;
  inputSchema: Record<string, unknown>;
}

interface ToolResult<T> {
  structuredContent: T;
  isError?: boolean;
}

function toolsListRequest(): Request {
  return new Request("https://mcp.test/mcp", {
    method: "POST",
    headers: { authorization: token, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

async function mcp(
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

async function bootControlPlaneApi(seen: SeenRequest[]): Promise<string> {
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

function controlPlaneResponse(request: IncomingMessage): { status: number; body: unknown } {
  if (request.method === "GET" && request.url === "/apps/app_local/flags") {
    return { status: 200, body: upstreamFlagPage };
  }
  if (request.method === "PATCH" && request.url === "/apps/app_local/flags/flag_checkout") {
    return { status: 200, body: updatedFlag };
  }
  if (request.method === "POST" && request.url === "/apps/app_local/flags") {
    return { status: 400, body: validationError };
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
