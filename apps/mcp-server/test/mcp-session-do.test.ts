import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handleMcpServerRequest } from "../src/mcp-handler";
import {
  durableMcpSessionStore,
  type McpSessionDurableObjectNamespace,
} from "../src/mcp-session-store";

const namespace = (env as unknown as { MCP_SESSIONS: McpSessionDurableObjectNamespace })
  .MCP_SESSIONS;

describe("MCP session Durable Object transport", () => {
  it("preserves inherited route scope after the session isolate is evicted", async () => {
    const store = durableMcpSessionStore(namespace);
    const sessionId = await initialize(store);
    await useContext(store, sessionId);

    await evictDurableObject(namespace.getByName(sessionId) as DurableObjectStub);
    const seen: Request[] = [];
    await call("tools/call", promotion(), store, sessionId, seen);

    expect(new URL(seen[0]?.url ?? "https://invalid").pathname).toBe(
      "/apps/app_session/envs/env_session/flags/flag_checkout/promote",
    );
  });

  it("rejects reuse after explicit session termination", async () => {
    const store = durableMcpSessionStore(namespace);
    const sessionId = await initialize(store);
    await useContext(store, sessionId);

    const ended = await handleMcpServerRequest({
      request: new Request("https://mcp.test/mcp", {
        method: "DELETE",
        headers: { "mcp-session-id": sessionId },
      }),
      service: "splitch-mcp-server",
      sessionStore: store,
    });
    expect(ended.status).toBe(204);
    expect((await call("tools/call", promotion(), store, sessionId)).status).toBe(404);
  });

  it("deletes expired session context when its alarm fires", async () => {
    const store = durableMcpSessionStore(namespace);
    const sessionId = await initialize(store);
    await useContext(store, sessionId);
    const stub = namespace.getByName(sessionId);

    await evictDurableObject(stub as DurableObjectStub);
    expect(await runDurableObjectAlarm(stub as DurableObjectStub)).toBe(true);
    expect((await call("tools/call", promotion(), store, sessionId)).status).toBe(404);
  });

  it("rejects and cleans up a session when the request observes expiry", async () => {
    let now = Date.now();
    const store = durableMcpSessionStore(namespace, { now: () => now, ttlMs: 60_000 });
    const sessionId = await initialize(store);
    await useContext(store, sessionId);

    now += 60_001;
    expect((await call("tools/call", promotion(), store, sessionId)).status).toBe(404);
    expect(await runDurableObjectAlarm(namespace.getByName(sessionId) as DurableObjectStub)).toBe(
      false,
    );
  });

  it("rejects an unknown session before JSON-RPC dispatch", async () => {
    const store = durableMcpSessionStore(namespace);
    const response = await call("tools/call", promotion(), store, crypto.randomUUID());

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("MCP session not found");
  });
});

async function initialize(store: ReturnType<typeof durableMcpSessionStore>): Promise<string> {
  const response = await call("initialize", undefined, store);
  const sessionId = response.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  return sessionId as string;
}

async function useContext(
  store: ReturnType<typeof durableMcpSessionStore>,
  sessionId: string,
): Promise<void> {
  const response = await call(
    "tools/call",
    { name: "context_use", arguments: { appId: "app_session", environmentId: "env_session" } },
    store,
    sessionId,
  );
  expect(await toolError(response)).toBeNull();
}

function promotion(): unknown {
  return {
    name: "flags_promote",
    arguments: { flagId: "flag_checkout", fromEnvironmentId: "source", select: { enabled: true } },
  };
}

async function call(
  method: string,
  params: unknown,
  sessionStore: ReturnType<typeof durableMcpSessionStore>,
  sessionId?: string,
  seen: Request[] = [],
): Promise<Response> {
  return handleMcpServerRequest({
    request: new Request("https://mcp.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    service: "splitch-mcp-server",
    platformTarget: "local",
    sessionStore,
    controlPlaneFetch: async (request) => {
      seen.push(request instanceof Request ? request : new Request(request));
      return Response.json(
        { code: "FLAG_NOT_FOUND", message: "not found", details: {} },
        { status: 404 },
      );
    },
  });
}

async function toolError(response: Response): Promise<string | null> {
  const body = (await response.clone().json()) as {
    result?: { isError?: boolean; structuredContent?: { message?: string } };
  };
  return body.result?.isError ? (body.result.structuredContent?.message ?? "tool error") : null;
}
