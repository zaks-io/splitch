import { handleMcpServerRequest } from "./mcp-handler";
import { memorySessionStore } from "./mcp-oauth-prm-harness";
import type { McpSessionStore } from "./mcp-session-context";
import {
  allowMcpRevocations,
  staticMcpTokenVerifier,
  TEST_MCP_DELEGATION_SECRET,
} from "./mcp-test-verifier";

const service = "splitch-mcp-server";
const defaultAuthorization = "Bearer local-test-token";

export interface ThrowingSessionStoreProbe {
  body: {
    error?: { code: number; message: string };
    result?: { isError?: boolean; structuredContent?: { message?: string } };
  };
  calls: number;
}

/**
 * A store whose `.get` succeeds once (satisfying mcp-transport.ts's
 * validateSession, which reads the session before dispatch) and throws on the
 * second read, isolating resolveScope's own call site
 * (mcp-session-context.ts:73-84) from the transport's.
 */
export async function callWithThrowingSessionStore(): Promise<ThrowingSessionStoreProbe> {
  let calls = 0;
  const store: McpSessionStore = {
    ...memorySessionStore(),
    async get() {
      calls += 1;
      if (calls === 1) return undefined;
      throw new Error("mcp-server: session store outage");
    },
  };
  const sessionId = await store.create("user_local_test", { authDoor: "id_jag" });

  const response = await handleMcpServerRequest({
    request: new Request("https://mcp.test/mcp", {
      method: "POST",
      headers: {
        authorization: defaultAuthorization,
        "content-type": "application/json",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "experiments_list", arguments: {} },
      }),
    }),
    service,
    platformTarget: "local",
    tokenVerifier: staticMcpTokenVerifier(),
    revocations: allowMcpRevocations(),
    controlPlaneDelegationSecret: TEST_MCP_DELEGATION_SECRET,
    controlPlaneFetch: async () =>
      Response.json({ items: [], readLimit: 200, readTruncated: false, cursor: null }),
    sessionStore: store,
  });

  return { body: (await response.json()) as ThrowingSessionStoreProbe["body"], calls };
}
