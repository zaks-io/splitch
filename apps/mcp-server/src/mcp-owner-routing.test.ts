import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { handleMcpServerRequest } from "./mcp-handler.js";

const service = "splitch-mcp-server";
const token = "Bearer local-test-token";

const testEvaluation = {
  variantName: "on",
  value: true,
  reason: { type: "no_match_default" },
  liveRunId: null,
};

const auditLogPage = {
  items: [
    {
      eventId: "evt_1",
      environmentId: "env_prod",
      actor: "user_1",
      action: "flags_update",
      at: "2026-07-03T02:00:00.000Z",
    },
  ],
  cursor: null,
  limit: 10,
  total: null,
};

let cleanupServers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanupServers.map((cleanup) => cleanup()));
  cleanupServers = [];
});

describe("mcp server owner routing", () => {
  it("routes evaluation-owned tools through the Evaluation API origin", async () => {
    const controlSeen: SeenRequest[] = [];
    const evaluationSeen: SeenRequest[] = [];
    const controlPlaneBaseUrl = await bootApi(controlSeen, handleControlPlaneRequest);
    const evaluationBaseUrl = await bootApi(evaluationSeen, handleEvaluationRequest);
    const response = await mcp(
      "tools/call",
      {
        name: "flags_test_eval",
        arguments: {
          appId: "app_local",
          environmentId: "env_prod",
          flagId: "flag_checkout",
          evaluationContext: {
            targetingKey: "user_1",
            idType: "user",
            attributes: { plan: "team" },
          },
        },
      },
      { controlPlaneBaseUrl, evaluationBaseUrl },
    );
    const body = (await response.json()) as JsonRpcSuccess<ToolResult<typeof testEvaluation>>;

    expect(controlSeen).toEqual([]);
    expect(evaluationSeen).toEqual([
      {
        method: "POST",
        path: "/apps/app_local/envs/env_prod/flags/flag_checkout/test-eval",
        authorization: token,
        body: JSON.stringify({
          evaluationContext: {
            targetingKey: "user_1",
            idType: "user",
            attributes: { plan: "team" },
          },
        }),
      },
    ]);
    expect(body.result.structuredContent).toEqual(testEvaluation);
  });

  it("routes analysis-owned tools through the Analysis API origin", async () => {
    const controlSeen: SeenRequest[] = [];
    const analysisSeen: SeenRequest[] = [];
    const controlPlaneBaseUrl = await bootApi(controlSeen, handleControlPlaneRequest);
    const analysisBaseUrl = await bootApi(analysisSeen, handleAnalysisRequest);
    const response = await mcp(
      "tools/call",
      {
        name: "audit_log_list",
        arguments: {
          appId: "app_local",
          limit: "10",
          environmentId: "env_prod",
        },
      },
      { controlPlaneBaseUrl, analysisBaseUrl },
    );
    const body = (await response.json()) as JsonRpcSuccess<ToolResult<typeof auditLogPage>>;

    expect(controlSeen).toEqual([]);
    expect(analysisSeen).toEqual([
      {
        method: "GET",
        path: "/apps/app_local/audit-log?limit=10&environmentId=env_prod",
        authorization: token,
        body: "",
      },
    ]);
    expect(body.result.structuredContent).toEqual(auditLogPage);
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

interface ToolResult<T> {
  structuredContent: T;
}

type ApiHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  seen: SeenRequest[],
) => Promise<void>;

async function mcp(
  method: string,
  params: unknown,
  baseUrls: {
    controlPlaneBaseUrl?: string;
    evaluationBaseUrl?: string;
    analysisBaseUrl?: string;
  },
): Promise<Response> {
  return handleMcpServerRequest({
    request: new Request("https://mcp.test/mcp", {
      method: "POST",
      headers: { authorization: token, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    service,
    platformTarget: "local",
    ...baseUrls,
  });
}

async function bootApi(seen: SeenRequest[], handler: ApiHandler): Promise<string> {
  const server = createServer((request, response) => {
    void handler(request, response, seen);
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
  await recordRequest(request, seen);
  writeJson(response, 404, { code: "FLAG_NOT_FOUND", message: "not found", details: {} });
}

async function handleEvaluationRequest(
  request: IncomingMessage,
  response: ServerResponse,
  seen: SeenRequest[],
): Promise<void> {
  await recordRequest(request, seen);
  if (
    request.method === "POST" &&
    request.url === "/apps/app_local/envs/env_prod/flags/flag_checkout/test-eval"
  ) {
    writeJson(response, 200, testEvaluation);
    return;
  }
  writeJson(response, 404, { code: "FLAG_NOT_FOUND", message: "not found", details: {} });
}

async function handleAnalysisRequest(
  request: IncomingMessage,
  response: ServerResponse,
  seen: SeenRequest[],
): Promise<void> {
  await recordRequest(request, seen);
  if (
    request.method === "GET" &&
    request.url === "/apps/app_local/audit-log?limit=10&environmentId=env_prod"
  ) {
    writeJson(response, 200, auditLogPage);
    return;
  }
  writeJson(response, 404, { code: "APP_NOT_FOUND", message: "not found", details: {} });
}

async function recordRequest(request: IncomingMessage, seen: SeenRequest[]): Promise<void> {
  seen.push({
    method: request.method ?? "",
    path: request.url ?? "",
    authorization: request.headers.authorization ?? null,
    body: await readRequestBody(request),
  });
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
