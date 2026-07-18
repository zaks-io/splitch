import { evictDurableObject, runDurableObjectAlarm, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { McpSessionDurableObjectNamespace } from "../src/mcp-session-store";

const namespace = (env as unknown as { MCP_SESSIONS: McpSessionDurableObjectNamespace })
  .MCP_SESSIONS;
const authorization = "Bearer worker-boundary-test-token";

describe("MCP session Worker transport", () => {
  it("preserves session context after the Durable Object isolate is evicted", async () => {
    const sessionId = await initialize();
    await useContext(sessionId);
    const stub = namespace.getByName(sessionId);

    await evictDurableObject(stub as DurableObjectStub);

    expect(await stub.getContext(Date.now())).toEqual({
      ok: true,
      value: { appId: "app_session", environmentId: "env_session" },
    });
    expect((await rpc("tools/list", undefined, sessionId)).status).toBe(200);
  });

  it("returns 404 before dispatch after explicit session termination", async () => {
    const sessionId = await initialize();
    await useContext(sessionId);

    const ended = await SELF.fetch("https://mcp.test/mcp", {
      method: "DELETE",
      headers: { authorization, "mcp-session-id": sessionId },
    });

    expect(ended.status).toBe(204);
    await expectDeadSession(sessionId);
  });

  it("returns 404 before dispatch after the expiry alarm deletes context", async () => {
    const sessionId = await initialize();
    await useContext(sessionId);
    const stub = namespace.getByName(sessionId);

    await evictDurableObject(stub as DurableObjectStub);
    expect(await runDurableObjectAlarm(stub as DurableObjectStub)).toBe(true);
    await expectDeadSession(sessionId);
  });

  it("returns 404 and cleans up when transport validation observes expiry", async () => {
    const sessionId = crypto.randomUUID();
    const stub = namespace.getByName(sessionId);
    expect(await stub.initialize(Date.now() - 1)).toEqual({ ok: true, value: undefined });

    await expectDeadSession(sessionId);
    expect(await runDurableObjectAlarm(stub as DurableObjectStub)).toBe(false);
  });

  it("returns 404 before dispatch for an unknown session", async () => {
    await expectDeadSession(crypto.randomUUID());
  });
});

async function initialize(): Promise<string> {
  const response = await rpc("initialize");
  const sessionId = response.headers.get("mcp-session-id");
  expect(response.status).toBe(200);
  expect(sessionId).toBeTruthy();
  return sessionId as string;
}

async function useContext(sessionId: string): Promise<void> {
  const response = await rpc(
    "tools/call",
    { name: "context_use", arguments: { appId: "app_session", environmentId: "env_session" } },
    sessionId,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    result: { structuredContent: { appId: "app_session", environmentId: "env_session" } },
  });
}

async function expectDeadSession(sessionId: string): Promise<void> {
  const response = await SELF.fetch("https://mcp.test/mcp", {
    method: "POST",
    headers: { authorization, "content-type": "application/json", "mcp-session-id": sessionId },
    body: "{malformed-dispatch-sentinel",
  });

  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toBe("text/plain;charset=UTF-8");
  expect(await response.text()).toBe("MCP session not found");
}

function rpc(method: string, params?: unknown, sessionId?: string): Promise<Response> {
  return SELF.fetch("https://mcp.test/mcp", {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}
