import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { deriveMcpProtocolTools, type ErrorResponse } from "@splitch/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { handleMcpServerRequest } from "./mcp-handler.js";

const service = "splitch-mcp-server";
const token = "Bearer local-test-token";

const flagPage = {
  items: [
    {
      id: "flag_checkout",
      appId: "app_local",
      key: "checkout",
      name: "Checkout",
      variants: [{ id: "var_on", name: "on", value: true }],
      defaultVariantId: "var_on",
      createdAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
    },
  ],
  cursor: null,
  limit: 50,
  total: null,
};

const validationError: ErrorResponse = {
  code: "VALIDATION_ERROR",
  message: "request failed schema validation",
  details: { issues: [{ path: ["body", "name"], message: "required" }] },
};

let cleanupServer: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanupServer?.();
  cleanupServer = undefined;
});

describe("mcp server Streamable HTTP transport", () => {
  it("lists the full S08-derived tool contract", async () => {
    const response = await mcp("tools/list");
    const body = (await response.json()) as JsonRpcSuccess<{ tools: unknown[] }>;

    expect(response.status).toBe(200);
    expect(body.result.tools).toHaveLength(deriveMcpProtocolTools().length);
    expect(body.result.tools).toContainEqual(
      expect.objectContaining({
        name: "flags_list",
        inputSchema: expect.objectContaining({ type: "object" }),
      }),
    );
  });

  it("forwards flags_list through the Control Plane SDK to a local HTTP API", async () => {
    const seen: SeenRequest[] = [];
    const baseUrl = await bootControlPlaneApi(seen);
    const response = await mcp(
      "tools/call",
      { name: "flags_list", arguments: { appId: "app_local" } },
      baseUrl,
    );
    const body = (await response.json()) as JsonRpcSuccess<ToolResult<typeof flagPage>>;

    expect(seen).toEqual([
      {
        method: "GET",
        path: "/apps/app_local/flags",
        authorization: token,
        body: "",
      },
    ]);
    expect(body.result.structuredContent).toEqual(flagPage);
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
    const response = await mcp(
      "tools/call",
      {
        name: "flags_create",
        arguments: {
          appId: "app_local",
          key: "checkout",
          schema: null,
          variants: [],
        },
      },
      baseUrl,
    );
    const body = (await response.json()) as JsonRpcSuccess<ToolResult<ErrorResponse>>;

    expect(seen[0]).toMatchObject({ method: "POST", path: "/apps/app_local/flags" });
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent).toEqual(validationError);
  });

  it("keeps wrangler config free of D1/KV/DO/Tinybird bindings", async () => {
    const config = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");

    expect(config).not.toMatch(/d1_databases|kv_namespaces|durable_objects/i);
    expect(config).not.toMatch(/tinybird|analytics_engine_datasets/i);
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

interface ToolResult<T> {
  structuredContent: T;
  isError?: boolean;
}

async function mcp(
  method: string,
  params?: unknown,
  controlPlaneBaseUrl?: string,
): Promise<Response> {
  return handleMcpServerRequest({
    request: new Request("https://mcp.test/mcp", {
      method: "POST",
      headers: { authorization: token, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    service,
    platformTarget: "local",
    controlPlaneBaseUrl,
  });
}

async function bootControlPlaneApi(seen: SeenRequest[]): Promise<string> {
  const server = createServer((request, response) => {
    void handleControlPlaneRequest(request, response, seen);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanupServer = () => new Promise<void>((resolve) => server.close(() => resolve()));
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

  if (request.method === "GET" && request.url === "/apps/app_local/flags") {
    writeJson(response, 200, flagPage);
    return;
  }
  if (request.method === "POST" && request.url === "/apps/app_local/flags") {
    writeJson(response, 400, validationError);
    return;
  }

  writeJson(response, 404, { code: "FLAG_NOT_FOUND", message: "not found", details: {} });
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
