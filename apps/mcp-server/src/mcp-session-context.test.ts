import { parseMcpDelegation } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { handleMcpServerRequest } from "./mcp-handler";
import type {
  McpSessionContext,
  McpSessionStore,
  McpSessionTransport,
} from "./mcp-session-context";
import {
  allowMcpRevocations,
  memoryMcpDelegationReplayGuard,
  staticMcpTokenVerifier,
  TEST_MCP_DELEGATION_SECRET,
} from "./mcp-test-verifier";

const service = "splitch-mcp-server";
const defaultAuthorization = "Bearer local-test-token";
const sessionStore = memorySessionStore();

describe("MCP session context", () => {
  it("validates the App and Environment before persisting context", async () => {
    const seen: Request[] = [];
    const sessionId = await initializeSession();
    const response = await mcp(
      "tools/call",
      { name: "context_use", arguments: { appId: "app_session", environmentId: "env_session" } },
      {
        sessionId,
        seen,
        useControlPlaneValidation: true,
        controlPlaneFetch: contextValidationFetch(seen),
      },
    );

    expect((await response.json()) as JsonRpcSuccess<ToolResult<unknown>>).toMatchObject({
      result: { structuredContent: { appId: "app_session", environmentId: "env_session" } },
    });
    expect(seen.map((request) => new URL(request.url).pathname)).toEqual([
      "/apps/app_session",
      "/apps/app_session/envs/env_session",
    ]);
    await expect(sessionStore.get(sessionId)).resolves.toEqual({
      appId: "app_session",
      environmentId: "env_session",
    });
  });

  it.each([
    {
      appId: "app_typo",
      environmentId: "env_session",
      message: 'App "app_typo" did not resolve.',
      paths: ["/apps/app_typo"],
    },
    {
      appId: "app_session",
      environmentId: "env_typo",
      message: 'Environment "env_typo" did not resolve in App "app_session".',
      paths: ["/apps/app_session", "/apps/app_session/envs/env_typo"],
    },
  ])("refuses an unresolved $appId / $environmentId without storing it", async (testCase) => {
    const seen: Request[] = [];
    const sessionId = await initializeSession();
    const response = await mcp(
      "tools/call",
      {
        name: "context_use",
        arguments: { appId: testCase.appId, environmentId: testCase.environmentId },
      },
      {
        sessionId,
        seen,
        useControlPlaneValidation: true,
        controlPlaneFetch: contextValidationFetch(seen),
      },
    );

    expect(await errorMessage(response)).toBe(testCase.message);
    expect(seen.map((request) => new URL(request.url).pathname)).toEqual(testCase.paths);
    await expect(sessionStore.get(sessionId)).resolves.toBeUndefined();
  });

  it("inherits session scope, lets explicit scope override it, and delegates without the bearer", async () => {
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

    expect(seen.map((request) => new URL(request.url).pathname)).toEqual([
      "/apps/app_session/envs/env_session/experiments",
      "/apps/app_explicit/envs/env_explicit/experiments",
    ]);
    for (const request of seen) {
      expect(request.headers.get("authorization")).toBeNull();
      expect(
        await parseMcpDelegation({
          request,
          surface: "control-plane-api",
          secret: TEST_MCP_DELEGATION_SECRET,
          replayGuard: memoryMcpDelegationReplayGuard(),
        }),
      ).toMatchObject({
        subject: "user_local_test",
      });
    }
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
        idempotency_key: "idem_flags_promote_probe",
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
  options: {
    authorization?: string;
    sessionId?: string;
    seen?: Request[];
    useControlPlaneValidation?: boolean;
    controlPlaneFetch?: typeof fetch;
  } = {},
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
    tokenVerifier: staticMcpTokenVerifier(),
    revocations: allowMcpRevocations(),
    controlPlaneDelegationSecret: TEST_MCP_DELEGATION_SECRET,
    controlPlaneFetch:
      options.controlPlaneFetch ??
      (async (request) => {
        options.seen?.push(request instanceof Request ? request : new Request(request));
        return Response.json({ items: [] });
      }),
    ...(options.useControlPlaneValidation
      ? {}
      : { sessionContextValidator: async () => ({ ok: true as const }) }),
    sessionStore,
  });
}

function contextValidationFetch(seen: Request[]): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    seen.push(request);
    const path = new URL(request.url).pathname;
    if (path === "/apps/app_session") {
      return Response.json({
        id: "app_session",
        organizationId: "org_session",
        name: "Session App",
        key: "session-app",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
      });
    }
    if (path === "/apps/app_session/envs/env_session") {
      return Response.json({
        id: "env_session",
        appId: "app_session",
        key: "session",
        name: "Session",
        policy: {
          variantAvailability: "allow",
          targetingRolloutValue: "allow",
          enabledState: "allow",
          startExperimentRun: "allow",
        },
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
      });
    }
    return Response.json(
      { code: "APP_NOT_FOUND", message: "resource not found", details: {} },
      { status: 404 },
    );
  };
}

function memorySessionStore(): McpSessionStore {
  const sessions = new Map<
    string,
    { context?: McpSessionContext; transport?: McpSessionTransport }
  >();
  return {
    async create(transport) {
      const id = crypto.randomUUID();
      sessions.set(id, { transport });
      return id;
    },
    async get(id) {
      if (!sessions.has(id)) throw new Error("mcp-server: MCP session is unknown or expired");
      return sessions.get(id)?.context;
    },
    async getTransport(id) {
      if (!sessions.has(id)) throw new Error("mcp-server: MCP session is unknown or expired");
      return sessions.get(id)?.transport;
    },
    async set(id, context) {
      if (!sessions.has(id)) throw new Error("mcp-server: MCP session is unknown or expired");
      const record = sessions.get(id);
      sessions.set(id, { ...record, context });
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
