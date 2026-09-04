import { describe, expect, it } from "vitest";
import { memorySessionStore } from "./mcp-oauth-prm-harness";
import type { McpSessionStore } from "./mcp-session-context";
import { routeTransportRequest } from "./mcp-transport";

const service = "splitch-mcp-server";
const owner = "user_owner";

describe("MCP transport authenticator requirement", () => {
  it("serves health without an authenticator", async () => {
    const response = await routeTransportRequest({
      request: new Request("https://mcp.test/health"),
      service,
      platformTarget: "local",
    });

    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ service });
  });

  it.each(["GET", "POST", "DELETE"] as const)(
    "fails closed on protected %s when authenticateBearer is missing",
    async (method) => {
      await expect(
        routeTransportRequest({
          request: new Request("https://mcp.test/mcp", {
            method,
            headers: { authorization: "Bearer local-test-token" },
          }),
          service,
          platformTarget: "local",
          sessionStore: memorySessionStore(),
        }),
      ).rejects.toThrow("mcp-server: authenticateBearer is required");
    },
  );
});

describe("MCP session DELETE", () => {
  it("returns 204 then the same opaque 404 on a repeated DELETE", async () => {
    const sessionStore = memorySessionStore();
    const sessionId = await sessionStore.create(owner);

    const first = await deleteSession(sessionStore, sessionId, owner);
    expect(first.status).toBe(204);
    expect(await first.text()).toBe("");

    const second = await deleteSession(sessionStore, sessionId, owner);
    await expectOpaqueDeadSession(second);
  });

  it("returns 404, not 500, when the session expires between get and end", async () => {
    const sessionStore = expireBetweenGetAndEndStore();
    const sessionId = await sessionStore.create(owner);
    expect(await sessionStore.get(sessionId, owner)).toBeUndefined();

    const response = await deleteSession(sessionStore, sessionId, owner);
    await expectOpaqueDeadSession(response);
  });
});

async function deleteSession(
  sessionStore: McpSessionStore,
  sessionId: string,
  subject: string,
): Promise<Response> {
  const response = await routeTransportRequest({
    request: new Request("https://mcp.test/mcp", {
      method: "DELETE",
      headers: {
        authorization: "Bearer local-test-token",
        "mcp-session-id": sessionId,
      },
    }),
    service,
    platformTarget: "local",
    sessionStore,
    authenticateBearer: async () => subject,
  });
  if (!response) throw new Error("expected a DELETE transport response");
  return response;
}

async function expectOpaqueDeadSession(response: Response): Promise<void> {
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toBe("text/plain;charset=UTF-8");
  expect(await response.text()).toBe("MCP session not found");
}

/**
 * A live session whose get still succeeds, then end observes expiry. This is
 * the DELETE race: validation and termination used to be two hops, and a
 * generic Error from the second hop escaped as a 500.
 */
function expireBetweenGetAndEndStore(): McpSessionStore {
  const inner = memorySessionStore();
  return {
    create: (subject, transport) => inner.create(subject, transport),
    get: (id, subject) => inner.get(id, subject),
    getTransport: (id, subject) => inner.getTransport(id, subject),
    set: (id, context, subject) => inner.set(id, context, subject),
    async end(id, subject) {
      await inner.get(id, subject);
      await inner.end(id, subject);
      return inner.end(id, subject);
    },
  };
}
