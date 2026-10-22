import type { McpSpanRecorder } from "@splitch/observability/mcp-spans";
import type { PerformanceSpanRecorder } from "@splitch/observability/performance-spans";
import { afterEach, expect, it, vi } from "vitest";
import { handleMcpServerRequest } from "./mcp-handler";
import { memorySessionStore } from "./mcp-oauth-prm-harness";
import { staticMcpTokenVerifier } from "./mcp-test-verifier";

afterEach(() => vi.useRealTimers());

it("keeps initialize open through awaited session creation", async () => {
  vi.useFakeTimers();
  const durations: Record<string, number> = {};
  const spans: McpSpanRecorder = {
    async record(descriptor, run) {
      const start = Date.now();
      try {
        return await run({ setToolResult() {} });
      } finally {
        durations[descriptor.method] = Date.now() - start;
      }
    },
  };
  const performanceSpans: PerformanceSpanRecorder = {
    async record(descriptor, run) {
      const start = Date.now();
      try {
        return await run({ setAttribute() {}, setAttributes() {} });
      } finally {
        durations[descriptor.name] = Date.now() - start;
      }
    },
  };
  const store = memorySessionStore();
  const verifier = staticMcpTokenVerifier();
  const start = Date.now();
  const response = handleMcpServerRequest({
    request: new Request("https://mcp.test/", {
      method: "POST",
      headers: { authorization: "Bearer local-test-token", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    }),
    service: "splitch-mcp-server",
    platformTarget: "local",
    spans,
    performanceSpans,
    tokenVerifier: {
      async verify(...args) {
        await delay(20);
        return verifier.verify(...args);
      },
    },
    revocations: {
      async isRevoked() {
        await delay(5);
        return false;
      },
    },
    sessionStore: {
      ...store,
      async create(...args) {
        await delay(40);
        return store.create(...args);
      },
    },
  });
  await vi.runAllTimersAsync();
  expect((await response).status).toBe(200);
  expect(Date.now() - start).toBe(65);
  expect(durations).toEqual({
    initialize: 40,
    "mcp.auth.bearer.verify": 25,
    "mcp.auth.oauth.verify": 20,
    "mcp.auth.revocation": 5,
    "mcp.request.parse": 0,
    "mcp.session.create": 40,
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

it("still rejects a session header when the session store is missing", async () => {
  await expect(
    handleMcpServerRequest({
      request: new Request("https://mcp.test/", {
        method: "POST",
        headers: { authorization: "Bearer local-test-token", "mcp-session-id": "unknown-session" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      service: "splitch-mcp-server",
      platformTarget: "local",
      tokenVerifier: staticMcpTokenVerifier(),
      revocations: { isRevoked: async () => false },
    }),
  ).rejects.toThrow("mcp-server: MCP session store is not configured");
});
