import { expect } from "vitest";
import type { McpAccessTokenActor } from "./mcp-access-token";
import { handleMcpServerRequest } from "./mcp-handler";
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
 * Shared harness for the MCP resource-discovery tests. Extracted from
 * mcp-resources.test.ts for file size; it holds only the request driver and the
 * session-store fakes, so the test file is assertions.
 */

const service = "splitch-mcp-server";
const defaultAuthorization = "Bearer local-test-token";

export const demoExpiresAt = "2026-07-22T00:00:00.000Z";
const authIssuer = "http://localhost:8791";

export const anonymousActor: McpAccessTokenActor = {
  subject: "user_anon",
  scopes: ["app:app_session:member"],
  authDoor: "anonymous",
  demoExpiresAt,
};

const DEFAULT_ACTOR: McpAccessTokenActor = {
  subject: "user_local_test",
  scopes: ["app:app_local:admin"],
  authDoor: "id_jag",
};

export const authFixture = `# splitch auth

Use one of the supported auth doors, then exchange the resulting credential at ${authIssuer}/oauth2/token.

- Anonymous: POST ${authIssuer}/agent/identity
- Claim ceremony: POST ${authIssuer}/agent/identity/claim
- Device flow: POST ${authIssuer}/oauth2/device_authorization with one App ID or slug selector, then poll ${authIssuer}/oauth2/token with the sealed device_code grant
- Revoke: POST ${authIssuer}/oauth2/revoke
`;

export interface JsonRpcSuccess<T> {
  result: T;
}

export interface JsonRpcError {
  error: {
    code: number;
    message: string;
    data?: { message?: string };
  };
}

export interface McpCallOptions {
  authorization?: string;
  sessionId?: string;
  sessionStore?: McpSessionStore;
  actor?: McpAccessTokenActor;
}

export async function mcp(
  method: string,
  params?: unknown,
  options: McpCallOptions = {},
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
    tokenVerifier: staticMcpTokenVerifier(options.actor ?? DEFAULT_ACTOR),
    revocations: allowMcpRevocations(),
    controlPlaneDelegationSecret: TEST_MCP_DELEGATION_SECRET,
    controlPlaneFetch: async () => Response.json({ items: [] }),
    sessionContextValidator: async () => ({ ok: true }),
    sessionStore: options.sessionStore ?? trackingSessionStore(),
    fetchAuthMarkdown: async () => authFixture,
  });
}

export async function initializeSession(
  sessionStore: McpSessionStore,
  actor: McpAccessTokenActor = DEFAULT_ACTOR,
): Promise<string> {
  const response = await mcp("initialize", undefined, { sessionStore, actor });
  const sessionId = response.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  return sessionId as string;
}

export function trackingSessionStore(): McpSessionStore & { writes: number } {
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

export function failingSessionStore(): McpSessionStore {
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
