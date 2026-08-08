import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MCP_RESOURCE_URIS } from "./mcp-resources";
import {
  anonymousActor,
  authFixture,
  demoExpiresAt,
  failingSessionStore,
  initializeSession,
  type JsonRpcError,
  type JsonRpcSuccess,
  mcp,
  trackingSessionStore,
} from "./mcp-resources-harness";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MCP resources discovery", () => {
  it("lists all five splitch resources", async () => {
    const response = await mcp("resources/list");
    const body = (await response.json()) as JsonRpcSuccess<{
      resources: Array<{ uri: string }>;
    }>;

    expect(response.status).toBe(200);
    expect(body.result.resources.map((resource) => resource.uri)).toEqual([...MCP_RESOURCE_URIS]);
  });

  it("serves splitch://context byte-equal to CONTEXT.md", async () => {
    const expected = await readFile(new URL("../../../CONTEXT.md", import.meta.url), "utf8");
    const response = await mcp("resources/read", { uri: "splitch://context" });
    const body = (await response.json()) as JsonRpcSuccess<{
      contents: Array<{ uri: string; mimeType: string; text: string }>;
    }>;

    expect(body.result.contents).toEqual([
      {
        uri: "splitch://context",
        mimeType: "text/markdown",
        text: expected,
      },
    ]);
  });

  it("serves splitch://quickstart byte-equal to docs/spec/quickstart.md", async () => {
    const expected = await readFile(
      new URL("../../../docs/spec/quickstart.md", import.meta.url),
      "utf8",
    );
    const response = await mcp("resources/read", { uri: "splitch://quickstart" });
    const body = (await response.json()) as JsonRpcSuccess<{
      contents: Array<{ text: string }>;
    }>;

    expect(body.result.contents[0]?.text).toBe(expected);
  });

  it("serves auth.md without advertising Door A while paused", async () => {
    const response = await mcp("resources/read", { uri: "splitch://auth" });
    const body = (await response.json()) as JsonRpcSuccess<{
      contents: Array<{ text: string }>;
    }>;
    const text = body.result.contents[0]?.text ?? "";

    expect(text).toBe(authFixture);
    expect(text).not.toMatch(/\bDoor A\b/i);
    expect(text).not.toMatch(/\bid_jag\b/i);
    expect(text).not.toMatch(/\bID-JAG\b/);
  });

  it("reflects a prior context_use and anonymous-door demo expiry from the session transport", async () => {
    const sessionStore = trackingSessionStore();
    const sessionId = await initializeSession(sessionStore, anonymousActor);

    await mcp(
      "tools/call",
      { name: "context_use", arguments: { appId: "app_session", environmentId: "env_session" } },
      { sessionId, sessionStore, actor: anonymousActor },
    );

    const response = await mcp(
      "resources/read",
      { uri: "splitch://active-context" },
      { sessionId, sessionStore, actor: anonymousActor },
    );
    const body = (await response.json()) as JsonRpcSuccess<{
      contents: Array<{ text: string }>;
    }>;

    expect(JSON.parse(body.result.contents[0]?.text ?? "{}")).toEqual({
      app: { id: "app_session" },
      environment: { id: "env_session" },
      source: "session",
      demoExpiresAt,
    });
    expect(await sessionStore.getTransport(sessionId)).toEqual({
      authDoor: "anonymous",
      demoExpiresAt,
    });
  });
});

describe("MCP resource reads", () => {
  it("returns a structured resource-read error when the session store fails", async () => {
    const logged: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    const sessionStore = failingSessionStore();
    const sessionId = await initializeSession(sessionStore);

    const response = await mcp(
      "resources/read",
      { uri: "splitch://active-context" },
      { sessionId, sessionStore },
    );
    const body = (await response.json()) as JsonRpcError;

    expect(body.error).toMatchObject({ code: -32603, message: "Internal error" });
    // The store's own words go to the Worker log; the caller gets its handle.
    expect(String(logged[0]?.[1])).toContain("session store read failed");
    expect(body.error.data).toMatchObject({ reference: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  });

  it("returns null active-context fields when the session has no selected context", async () => {
    const sessionStore = trackingSessionStore();
    const sessionId = await initializeSession(sessionStore);

    const response = await mcp(
      "resources/read",
      { uri: "splitch://active-context" },
      { sessionId, sessionStore },
    );
    const body = (await response.json()) as JsonRpcSuccess<{
      contents: Array<{ text: string }>;
    }>;

    expect(JSON.parse(body.result.contents[0]?.text ?? "{}")).toEqual({
      app: null,
      environment: null,
      source: null,
    });
  });

  it("derives splitch://capabilities scopes from the session token using Worker membership gates", async () => {
    const response = await mcp(
      "resources/read",
      { uri: "splitch://capabilities" },
      {
        authorization: "Bearer scoped-token",
        actor: {
          subject: "user_scoped",
          scopes: ["app:app_local:admin", "org:org_local:member"],
          authDoor: "id_jag",
        },
      },
    );
    const body = (await response.json()) as JsonRpcSuccess<{
      contents: Array<{ text: string }>;
    }>;
    const payload = JSON.parse(body.result.contents[0]?.text ?? "{}") as {
      scopes: string[];
      tools: Array<{ name: string; gate: string[]; grantedBy: string[] }>;
    };

    expect(payload.scopes).toEqual(["app:app_local:admin", "org:org_local:member"]);
    expect(payload.tools.find((tool) => tool.name === "flags_list")).toMatchObject({
      gate: ["app:member"],
      grantedBy: ["app:app_local:admin"],
    });
    expect(payload.tools.find((tool) => tool.name === "organizations_list")).toMatchObject({
      gate: ["token"],
      grantedBy: ["app:app_local:admin", "org:org_local:member"],
    });
    expect(payload.tools.find((tool) => tool.name === "organizations_update")).toMatchObject({
      gate: ["org:owner"],
      grantedBy: [],
    });
    expect(payload.tools.find((tool) => tool.name === "organization_members_list")).toMatchObject({
      gate: ["org:admin"],
      grantedBy: [],
    });
    expect(payload.tools.find((tool) => tool.name === "flags_delete")).toMatchObject({
      gate: ["app:admin"],
      grantedBy: ["app:app_local:admin"],
    });
  });

  it("performs zero writes while reading every resource", async () => {
    const sessionStore = trackingSessionStore();
    const sessionId = await initializeSession(sessionStore, anonymousActor);
    await mcp(
      "tools/call",
      { name: "context_use", arguments: { appId: "app_session", environmentId: "env_session" } },
      { sessionId, sessionStore, actor: anonymousActor },
    );

    for (const uri of MCP_RESOURCE_URIS) {
      const before = sessionStore.writes;
      const response = await mcp(
        "resources/read",
        { uri },
        { sessionId, sessionStore, actor: anonymousActor },
      );
      expect(response.status).toBe(200);
      expect(sessionStore.writes).toBe(before);
    }
  });
});
