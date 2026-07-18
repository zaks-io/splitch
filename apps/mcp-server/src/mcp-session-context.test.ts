import { describe, expect, it } from "vitest";
import { handleMcpServerRequest } from "./mcp-handler";
import type { McpSessionContext, McpSessionStore } from "./mcp-session-context";

const service = "splitch-mcp-server";
const defaultAuthorization = "Bearer local-test-token";
const sessionStore = memorySessionStore();

describe("MCP session context", () => {
  it("inherits session scope, lets explicit scope override it, and preserves the bearer token", async () => {
    const seen: Request[] = [];
    const authorization = "Bearer header.payload.signature-with-scopes-unchanged";
    const sessionId = await initializeSession();

    const setContext = await mcp(
      "tools/call",
      { name: "context_use", arguments: { appId: "app_session", environmentId: "env_session" } },
      { sessionId, authorization, seen },
    );
    expect((await setContext.json()) as JsonRpcSuccess<ToolResult<unknown>>).toMatchObject({
      result: { structuredContent: { appId: "app_session", environmentId: "env_session" } },
    });

    await mcp(
      "tools/call",
      { name: "experiments_list", arguments: {} },
      { sessionId, authorization, seen },
    );
    await mcp(
      "tools/call",
      {
        name: "experiments_list",
        arguments: { appId: "app_explicit", environmentId: "env_explicit" },
      },
      { sessionId, authorization, seen },
    );

    expect(
      seen.map((request) => [new URL(request.url).pathname, request.headers.get("authorization")]),
    ).toEqual([
      ["/apps/app_session/envs/env_session/experiments", authorization],
      ["/apps/app_explicit/envs/env_explicit/experiments", authorization],
    ]);
  });

  it("fails loud with each missing scope axis instead of calling an arbitrary App", async () => {
    const seen: Request[] = [];
    const appMissing = await mcp(
      "tools/call",
      { name: "experiments_list", arguments: {} },
      { seen },
    );
    expect(await errorMessage(appMissing)).toContain("App scope is unresolved");

    const environmentMissing = await mcp(
      "tools/call",
      { name: "experiments_list", arguments: { appId: "app_explicit" } },
      { seen },
    );
    expect(await errorMessage(environmentMissing)).toContain("Environment scope is unresolved");
    expect(seen).toEqual([]);
  });

  it("inherits target Environment route metadata and lets an explicit target override it", async () => {
    const seen: Request[] = [];
    const sessionId = await initializeSession();
    await mcp(
      "tools/call",
      { name: "context_use", arguments: { appId: "app_session", environmentId: "env_session" } },
      { sessionId, seen },
    );

    const promotion = {
      name: "flags_promote",
      arguments: {
        flagId: "flag_checkout",
        fromEnvironmentId: "env_source",
        select: { enabled: true },
      },
    };
    await mcp("tools/call", promotion, { sessionId, seen });
    await mcp(
      "tools/call",
      { ...promotion, arguments: { ...promotion.arguments, targetEnvironmentId: "env_explicit" } },
      { sessionId, seen },
    );

    expect(seen.map((request) => new URL(request.url).pathname)).toEqual([
      "/apps/app_session/envs/env_session/flags/flag_checkout/promote",
      "/apps/app_session/envs/env_explicit/flags/flag_checkout/promote",
    ]);
  });
});

async function initializeSession(): Promise<string> {
  const response = await mcp("initialize");
  const sessionId = response.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  return sessionId as string;
}

async function mcp(
  method: string,
  params?: unknown,
  options: { authorization?: string; sessionId?: string; seen?: Request[] } = {},
): Promise<Response> {
  return handleMcpServerRequest({
    request: new Request("https://mcp.test/mcp", {
      method: "POST",
      headers: {
        authorization: options.authorization ?? defaultAuthorization,
        "content-type": "application/json",
        ...(options.sessionId ? { "mcp-session-id": options.sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    service,
    platformTarget: "local",
    controlPlaneFetch: async (request) => {
      options.seen?.push(request instanceof Request ? request : new Request(request));
      return Response.json({ items: [] });
    },
    sessionStore,
  });
}

function memorySessionStore(): McpSessionStore {
  const sessions = new Map<string, McpSessionContext | undefined>();
  return {
    async create() {
      const id = crypto.randomUUID();
      sessions.set(id, undefined);
      return id;
    },
    async get(id) {
      if (!sessions.has(id)) throw new Error("mcp-server: MCP session is unknown or expired");
      return sessions.get(id);
    },
    async set(id, context) {
      if (!sessions.has(id)) throw new Error("mcp-server: MCP session is unknown or expired");
      sessions.set(id, context);
    },
    async end(id) {
      sessions.delete(id);
    },
  };
}

async function errorMessage(response: Response): Promise<string> {
  const body = (await response.json()) as JsonRpcSuccess<ToolResult<{ message: string }>>;
  expect(body.result.isError).toBe(true);
  return body.result.structuredContent.message;
}

interface JsonRpcSuccess<T> {
  result: T;
}

interface ToolResult<T> {
  structuredContent: T;
  isError?: boolean;
}
