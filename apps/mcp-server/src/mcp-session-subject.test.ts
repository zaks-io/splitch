import { describe, expect, it } from "vitest";
import type { McpAccessTokenActor } from "./mcp-access-token";
import { handleMcpServerRequest } from "./mcp-handler";
import { memorySessionStore } from "./mcp-oauth-prm-harness";
import { McpSessionNotFoundError } from "./mcp-session-store";
import {
  allowMcpRevocations,
  staticMcpTokenVerifier,
  TEST_MCP_DELEGATION_SECRET,
} from "./mcp-test-verifier";

const service = "splitch-mcp-server";
const owner: McpAccessTokenActor = {
  subject: "user_owner",
  scopes: ["app:app_local:admin"],
  authDoor: "id_jag",
};
const foreign: McpAccessTokenActor = {
  subject: "user_foreign",
  scopes: ["app:app_local:admin"],
  authDoor: "id_jag",
};

describe("MCP session subject binding", () => {
  it("lets the owner resume, and treats foreign replay as an unknown session", async () => {
    const sessionStore = memorySessionStore();
    const sessionId = await initialize(sessionStore, owner);

    const resumed = await mcp("tools/list", undefined, { sessionStore, actor: owner, sessionId });
    expect(resumed.status).toBe(200);

    const replay = await mcp("tools/list", undefined, {
      sessionStore,
      actor: foreign,
      sessionId,
    });
    await expectOpaqueDeadSession(replay);
    await expect(sessionStore.get(sessionId, owner.subject)).resolves.toBeUndefined();
    await expect(sessionStore.get(sessionId, foreign.subject)).rejects.toBeInstanceOf(
      McpSessionNotFoundError,
    );
  });

  it("refuses foreign mutate and end without revealing or deleting the owner session", async () => {
    const sessionStore = memorySessionStore();
    const sessionId = await initialize(sessionStore, owner);
    const setOwner = await mcp(
      "tools/call",
      { name: "context_use", arguments: { appId: "app_owner", environmentId: "env_owner" } },
      { sessionStore, actor: owner, sessionId },
    );
    expect(setOwner.status).toBe(200);

    const foreignMutate = await mcp(
      "tools/call",
      { name: "context_use", arguments: { appId: "app_stolen", environmentId: "env_stolen" } },
      { sessionStore, actor: foreign, sessionId },
    );
    await expectOpaqueDeadSession(foreignMutate);

    const foreignEnd = await handleMcpServerRequest({
      request: new Request("https://mcp.test/mcp", {
        method: "DELETE",
        headers: {
          authorization: "Bearer local-test-token",
          "mcp-session-id": sessionId,
        },
      }),
      service,
      platformTarget: "local",
      tokenVerifier: staticMcpTokenVerifier(foreign),
      revocations: allowMcpRevocations(),
      controlPlaneDelegationSecret: TEST_MCP_DELEGATION_SECRET,
      sessionStore,
    });
    await expectOpaqueDeadSession(foreignEnd);

    await expect(sessionStore.get(sessionId, owner.subject)).resolves.toEqual({
      appId: "app_owner",
      environmentId: "env_owner",
    });
  });

  it("treats replay after the owner ends the session as unknown", async () => {
    const sessionStore = memorySessionStore();
    const sessionId = await initialize(sessionStore, owner);
    const ended = await handleMcpServerRequest({
      request: new Request("https://mcp.test/mcp", {
        method: "DELETE",
        headers: {
          authorization: "Bearer local-test-token",
          "mcp-session-id": sessionId,
        },
      }),
      service,
      platformTarget: "local",
      tokenVerifier: staticMcpTokenVerifier(owner),
      revocations: allowMcpRevocations(),
      controlPlaneDelegationSecret: TEST_MCP_DELEGATION_SECRET,
      sessionStore,
    });
    expect(ended.status).toBe(204);

    const replay = await mcp("tools/list", undefined, { sessionStore, actor: owner, sessionId });
    await expectOpaqueDeadSession(replay);
  });

  it("returns the same opaque 404 on a repeated owner DELETE", async () => {
    const sessionStore = memorySessionStore();
    const sessionId = await initialize(sessionStore, owner);

    const first = await endSession(sessionStore, owner, sessionId);
    expect(first.status).toBe(204);

    const second = await endSession(sessionStore, owner, sessionId);
    await expectOpaqueDeadSession(second);
  });
});

async function endSession(
  sessionStore: ReturnType<typeof memorySessionStore>,
  actor: McpAccessTokenActor,
  sessionId: string,
): Promise<Response> {
  return handleMcpServerRequest({
    request: new Request("https://mcp.test/mcp", {
      method: "DELETE",
      headers: {
        authorization: "Bearer local-test-token",
        "mcp-session-id": sessionId,
      },
    }),
    service,
    platformTarget: "local",
    tokenVerifier: staticMcpTokenVerifier(actor),
    revocations: allowMcpRevocations(),
    controlPlaneDelegationSecret: TEST_MCP_DELEGATION_SECRET,
    sessionStore,
  });
}

async function initialize(
  sessionStore: ReturnType<typeof memorySessionStore>,
  actor: McpAccessTokenActor,
): Promise<string> {
  const response = await mcp("initialize", undefined, { sessionStore, actor });
  const sessionId = response.headers.get("mcp-session-id");
  expect(response.status).toBe(200);
  expect(sessionId).toBeTruthy();
  return sessionId as string;
}

async function mcp(
  method: string,
  params: unknown,
  options: {
    sessionStore: ReturnType<typeof memorySessionStore>;
    actor: McpAccessTokenActor;
    sessionId?: string;
  },
): Promise<Response> {
  return handleMcpServerRequest({
    request: new Request("https://mcp.test/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer local-test-token",
        "content-type": "application/json",
        ...(options.sessionId ? { "mcp-session-id": options.sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    service,
    platformTarget: "local",
    tokenVerifier: staticMcpTokenVerifier(options.actor),
    revocations: allowMcpRevocations(),
    controlPlaneDelegationSecret: TEST_MCP_DELEGATION_SECRET,
    sessionContextValidator: async () => ({ ok: true }),
    sessionStore: options.sessionStore,
  });
}

async function expectOpaqueDeadSession(response: Response): Promise<void> {
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toBe("text/plain;charset=UTF-8");
  expect(await response.text()).toBe("MCP session not found");
}
