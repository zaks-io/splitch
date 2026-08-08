import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleMcpServerRequest, type McpServerRequestOptions } from "./mcp-handler";
import { missingAnalysisBindingCall } from "./mcp-control-plane-dispatch.test-fixture";
import { failingSessionStore } from "./mcp-resources-harness";
import type {
  McpSessionContext,
  McpSessionStore,
  McpSessionTransport,
} from "./mcp-session-context";
import {
  allowMcpRevocations,
  staticMcpTokenVerifier,
  TEST_MCP_DELEGATION_SECRET,
} from "./mcp-test-verifier";

/**
 * Nothing an agent reads may name a module, a workspace package, or a Wrangler
 * binding. The agent cannot act on any of it, and a message like
 * `CONTROL_PLANE_API delegation secret is required` reads to it as its own
 * mistake. Driven by a vocabulary list over every error the server can produce,
 * so a leak from a new call site goes red without anyone remembering to add a
 * literal here.
 */
const FORBIDDEN_VOCABULARY = [
  // Wrangler bindings and Worker environment variables.
  "CONTROL_PLANE_API",
  "CONTROL_PLANE_API_ORIGIN",
  "AUTH_API_ORIGIN",
  "SESSION_STORE",
  "MCP_SESSIONS",
  "MCP_CONTROL_PLANE_DELEGATION_SECRET",
  "ANALYSIS_API",
  "EVALUATION_API",
  // Workspace package names.
  "@splitch/",
  "control-plane-sdk",
  "worker-runtime",
  // Internal module and Worker service names.
  "mcp-server",
  "mcp-prompts",
  "mcp-handler",
  "mcp-operation-sdks",
  "mcp-session-context",
  "mcp-resources",
  "mcp-transport",
  "mcp-access-token",
  "json-rpc",
  "control-plane-api",
  "evaluation-api",
  "analysis-api",
  "auth-api",
];

const INTERNAL_ERROR = -32603;
const sessionStore = memorySessionStore();

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MCP error vocabulary", () => {
  it("names no module, package, or binding in any error it returns", async () => {
    const bodies = await Promise.all([
      // Caller-fixable refusals.
      call({ name: "organizations_get", arguments: {} }),
      call({ name: "experiments_list", arguments: {} }),
      call({ name: "experiments_list", arguments: { appId: "app_local" } }),
      call({ name: "missing_tool", arguments: {} }),
      call({ name: "context_use", arguments: { appId: "" } }),
      call({ name: "context_use", arguments: { appId: "a", environmentId: "e" } }),
      rpc("prompts/get", { name: "not_a_prompt" }),
      rpc("prompts/get", { name: "recover_from_error", arguments: {} }),
      rpc("prompts/get", {
        name: "recover_from_error",
        arguments: { errorCode: "VALIDATION_ERROR", details: "{" },
      }),
      rpc("prompts/get", {
        name: "recover_from_error",
        arguments: { errorCode: "VALIDATION_ERROR", details: { recommendedAction: "nope" } },
      }),
      rpc("resources/read", { uri: "splitch://nowhere" }),
      // Faults: an unconfigured downstream, a failing session store, a failing
      // fetch. Each throws a message written for an operator.
      call({ name: "organizations_get", arguments: { orgId: "org_local" } }, {}),
      call(
        { name: "organizations_get", arguments: { orgId: "org_local" } },
        { withSecret: false, withFetch: true },
      ),
      contextUseWithoutDelegationSecret(),
      failingSessionStoreRead(),
      missingAnalysisBindingCall(),
      rpc(
        "resources/read",
        { uri: "splitch://auth" },
        {
          fetchAuthMarkdown: async () => {
            throw new Error("mcp-server: auth.md fetch failed (503)");
          },
        },
      ),
    ]);

    for (const body of bodies) {
      const serialized = JSON.stringify(body);
      expect(serialized, "probe returned no error").toMatch(/"(error|isError)"/);
      for (const term of FORBIDDEN_VOCABULARY) {
        expect(serialized, `leaks "${term}"`).not.toContain(term);
      }
    }
  });

  it("logs the whole fault and hands the caller a reference for it", async () => {
    const logged: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });

    const body = await call(
      { name: "organizations_get", arguments: { orgId: "org_local" } },
      { withSecret: false, withFetch: true },
    );
    const error = errorObject(body);

    expect(error.code).toBe(INTERNAL_ERROR);
    expect(error.message).toBe("Internal error");
    const data = error.data as { message: string; reference: string };
    expect(data.message).toContain("The arguments are not the problem");
    expect(data.reference).toMatch(/^[0-9a-f-]{36}$/);
    expect(logged).toHaveLength(1);
    expect(String(logged[0]?.[0])).toContain(data.reference);
    expect(String(logged[0]?.[1])).toContain("CONTROL_PLANE_API delegation secret is required");
  });
});

describe("MCP context_use failure classes", () => {
  it("reports a validator that throws as an internal error, not a bad argument", async () => {
    const body = await rpc(
      "tools/call",
      {
        name: "context_use",
        arguments: { appId: "app_session", environmentId: "env_session" },
      },
      {
        sessionId: await initializeSession(),
        sessionContextValidator: async () => {
          throw new Error("connect ECONNREFUSED 127.0.0.1:8788");
        },
      },
    );

    expect(errorObject(body).code).toBe(INTERNAL_ERROR);
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
  });

  it("still reports a refused App as the caller's to fix", async () => {
    const body = await rpc(
      "tools/call",
      { name: "context_use", arguments: { appId: "app_typo", environmentId: "env_session" } },
      {
        sessionId: await initializeSession(),
        sessionContextValidator: async () => ({
          ok: false as const,
          message: 'App "app_typo" did not resolve.',
        }),
      },
    );

    expect(body).toMatchObject({
      result: {
        isError: true,
        structuredContent: { message: 'App "app_typo" did not resolve.' },
      },
    });
  });

  it("refuses its own arguments before demanding the Control Plane origin", async () => {
    const body = await rpc(
      "tools/call",
      { name: "context_use", arguments: { appId: "app_session" } },
      { sessionId: await initializeSession(), platformTarget: "production", withSecret: false },
    );

    expect(body).toMatchObject({
      result: {
        isError: true,
        structuredContent: { message: "context_use requires non-empty appId and environmentId." },
      },
    });
  });
});

interface ProbeOptions {
  readonly sessionId?: string;
  readonly sessionStore?: McpSessionStore;
  readonly withSecret?: boolean;
  readonly withFetch?: boolean;
  readonly controlPlaneFetch?: McpServerRequestOptions["controlPlaneFetch"];
  readonly platformTarget?: string;
  readonly sessionContextValidator?: McpServerRequestOptions["sessionContextValidator"];
  readonly fetchAuthMarkdown?: McpServerRequestOptions["fetchAuthMarkdown"];
}

/** A tool call with the downstream fully configured unless a probe removes it. */
function call(params: unknown, options?: ProbeOptions): Promise<unknown> {
  return rpc("tools/call", params, options ?? { withSecret: true, withFetch: true });
}

async function rpc(method: string, params: unknown, options: ProbeOptions = {}): Promise<unknown> {
  const response = await handleMcpServerRequest({
    request: new Request("https://mcp.test/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer local-test-token",
        "content-type": "application/json",
        ...(options.sessionId ? { "mcp-session-id": options.sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    service: "splitch-mcp-server",
    platformTarget: options.platformTarget ?? "local",
    tokenVerifier: staticMcpTokenVerifier(),
    revocations: allowMcpRevocations(),
    sessionStore: options.sessionStore ?? sessionStore,
    ...(options.withSecret === false
      ? {}
      : { controlPlaneDelegationSecret: TEST_MCP_DELEGATION_SECRET }),
    ...(options.controlPlaneFetch
      ? { controlPlaneFetch: options.controlPlaneFetch }
      : options.withFetch
        ? { controlPlaneFetch: async () => Response.json({ items: [] }) }
        : {}),
    ...(options.sessionContextValidator
      ? { sessionContextValidator: options.sessionContextValidator }
      : {}),
    ...(options.fetchAuthMarkdown ? { fetchAuthMarkdown: options.fetchAuthMarkdown } : {}),
  });
  return await response.json();
}

/** No delegation secret, so the real validator's first call throws. */
async function contextUseWithoutDelegationSecret(): Promise<unknown> {
  return rpc(
    "tools/call",
    { name: "context_use", arguments: { appId: "app_session", environmentId: "env_session" } },
    { sessionId: await initializeSession(), withSecret: false },
  );
}

async function initializeSession(): Promise<string> {
  return await sessionStore.create({ authDoor: "id_jag" });
}

/** The session store throws mid-request, after the transport accepted the id. */
async function failingSessionStoreRead(): Promise<unknown> {
  const store = failingSessionStore();
  return rpc(
    "resources/read",
    { uri: "splitch://active-context" },
    { sessionId: await store.create(), sessionStore: store },
  );
}

function errorObject(body: unknown): { code: number; message: string; data?: unknown } {
  const error = (body as { error?: { code: number; message: string; data?: unknown } }).error;
  if (!error) throw new Error(`probe returned no JSON-RPC error: ${JSON.stringify(body)}`);
  return error;
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
      sessions.set(id, { ...sessions.get(id), context });
    },
    async end(id) {
      sessions.delete(id);
    },
  };
}
