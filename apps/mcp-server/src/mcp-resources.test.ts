import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { handleMcpServerRequest } from "./mcp-handler";
import type {
  McpSessionContext,
  McpSessionStore,
  McpSessionTransport,
} from "./mcp-session-context";
import { MCP_RESOURCE_URIS } from "./mcp-resources";
import {
  allowMcpRevocations,
  staticMcpTokenVerifier,
  TEST_MCP_DELEGATION_SECRET,
} from "./mcp-test-verifier";

const service = "splitch-mcp-server";
const defaultAuthorization = "Bearer local-test-token";
const demoExpiresAt = "2026-07-22T00:00:00.000Z";
const authIssuer = "http://localhost:8791";
const anonymousActor = {
  subject: "user_anon",
  scopes: ["app:app_session:member"],
  authDoor: "anonymous",
  demoExpiresAt,
};
const authFixture = `# splitch auth

Use one of the supported auth doors, then exchange the resulting credential at ${authIssuer}/oauth2/token.

- Anonymous: POST ${authIssuer}/agent/identity
- Claim ceremony: POST ${authIssuer}/agent/identity/claim
- Device flow: POST ${authIssuer}/oauth2/device_authorization with one App ID or slug selector, then poll ${authIssuer}/oauth2/token with the sealed device_code grant
- Revoke: POST ${authIssuer}/oauth2/revoke
`;

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

  it("returns a structured resource-read error when the session store fails", async () => {
    const sessionStore = failingSessionStore();
    const sessionId = await initializeSession(sessionStore);

    const response = await mcp(
      "resources/read",
      { uri: "splitch://active-context" },
      { sessionId, sessionStore },
    );
    const body = (await response.json()) as JsonRpcError;

    expect(body.error).toMatchObject({
      code: -32603,
      message: "Internal error",
      data: { message: "mcp-server: session store read failed" },
    });
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

async function initializeSession(
  sessionStore: McpSessionStore,
  actor: { subject: string; scopes: string[]; authDoor?: string; demoExpiresAt?: string } = {
    subject: "user_local_test",
    scopes: ["app:app_local:admin"],
  },
): Promise<string> {
  const response = await mcp("initialize", undefined, { sessionStore, actor });
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
    sessionStore?: McpSessionStore;
    actor?: { subject: string; scopes: string[]; authDoor?: string; demoExpiresAt?: string };
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
    authBaseUrl: authIssuer,
    tokenVerifier: staticMcpTokenVerifier(
      options.actor ?? {
        subject: "user_local_test",
        scopes: ["app:app_local:admin"],
      },
    ),
    revocations: allowMcpRevocations(),
    controlPlaneDelegationSecret: TEST_MCP_DELEGATION_SECRET,
    controlPlaneFetch: async () => Response.json({ items: [] }),
    sessionStore: options.sessionStore ?? trackingSessionStore(),
    fetchAuthMarkdown: async () => authFixture,
  });
}

function trackingSessionStore(): McpSessionStore & { writes: number } {
  const sessions = new Map<
    string,
    { context?: McpSessionContext; transport?: McpSessionTransport }
  >();
  return {
    writes: 0,
    async create(transport) {
      this.writes += 1;
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
      this.writes += 1;
      if (!sessions.has(id)) throw new Error("mcp-server: MCP session is unknown or expired");
      const record = sessions.get(id);
      sessions.set(id, { ...record, context });
    },
    async end(id) {
      this.writes += 1;
      sessions.delete(id);
    },
  };
}

function failingSessionStore(): McpSessionStore {
  return {
    async create() {
      return crypto.randomUUID();
    },
    async get() {
      return undefined;
    },
    async getTransport() {
      throw new Error("mcp-server: session store read failed");
    },
    async set() {
      throw new Error("mcp-server: session store write failed");
    },
    async end() {},
  };
}

interface JsonRpcSuccess<T> {
  result: T;
}

interface JsonRpcError {
  error: {
    code: number;
    message: string;
    data?: { message?: string };
  };
}
