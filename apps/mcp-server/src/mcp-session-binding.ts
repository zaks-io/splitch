import type { McpAccessTokenActor } from "./mcp-access-token";
import type { McpSessionStore, McpSessionTransport } from "./mcp-session-context";

export function createBoundSession(
  sessionStore: McpSessionStore,
  actor: McpAccessTokenActor,
): Promise<string> {
  return sessionStore.create(actor.subject, sessionTransportFromActor(actor));
}

function sessionTransportFromActor(actor: McpAccessTokenActor): McpSessionTransport {
  return {
    authDoor: actor.authDoor,
    ...(actor.demoExpiresAt ? { demoExpiresAt: actor.demoExpiresAt } : {}),
  };
}

export const unconfiguredSessionStore: McpSessionStore = {
  async create() {
    throw new Error("mcp-server: MCP session store is not configured");
  },
  async get() {
    return undefined;
  },
  async getTransport() {
    return undefined;
  },
  async set() {
    throw new Error("mcp-server: MCP session store is not configured");
  },
  async end() {
    throw new Error("mcp-server: MCP session store is not configured");
  },
};
