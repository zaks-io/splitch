import { env } from "cloudflare:workers";
import { createMcpSpanRecorder } from "@splitch/observability/mcp-spans";
import { createPerformanceSpanRecorder } from "@splitch/observability/performance-spans";
import { loadSentry } from "@splitch/observability/sentry-module";
import { workerSentryOptions } from "@splitch/observability/worker";
import { expect, it } from "vitest";
import { handleMcpServerRequest } from "../src/mcp-handler";
import {
  durableMcpSessionStore,
  type McpSessionDurableObjectNamespace,
} from "../src/mcp-session-store";
import { allowMcpRevocations, staticMcpTokenVerifier } from "../src/mcp-test-verifier";

interface RecordedSpan {
  name: string;
  span_id: string;
  parent_span_id: string;
  attributes: Record<string, { value: unknown }>;
}

it.each([
  ["codex-mcp-client", "codex"],
  ["mcp-inspector", "mcp-inspector"],
  ["local-test-client", "other"],
  ["user_7f3c9a2b", "other"],
  ["550e8400-e29b-41d4-a716-446655440000", "other"],
  ["2001:db8:85a3::8a2e:370:7334", "other"],
  ["Private workspace for the confidential acquisition planning team. ".repeat(4), "other"],
  ["person@example.com", "other"],
])(
  "exports auth and session DO spans with canonical client %j as %s",
  async (clientName, expected) => {
    const sentryEnv = { SENTRY_DSN: "https://public@sentry.invalid/1" };
    const Sentry = await loadSentry();
    Sentry.setAsyncLocalStorageAsyncContextStrategy();
    const recorded: RecordedSpan[] = [];
    const client = new Sentry.CloudflareClient({
      ...workerSentryOptions(sentryEnv, { surface: "mcp-server" }, Sentry),
      integrations: [],
      stackParser: () => [],
      transport: () => ({
        async send(envelope) {
          for (const [header, payload] of envelope[1]) {
            if (header.type === "span")
              recorded.push(...(payload as { items: RecordedSpan[] }).items);
          }
          return { statusCode: 200 };
        },
        flush: async () => true,
      }),
    });
    client.init();
    const sessionStore = durableMcpSessionStore(
      (env as unknown as { MCP_SESSIONS: McpSessionDurableObjectNamespace }).MCP_SESSIONS,
    );
    const options = {
      service: "splitch-mcp-server",
      platformTarget: "local",
      tokenVerifier: staticMcpTokenVerifier(),
      revocations: allowMcpRevocations(),
      sessionStore,
      spans: createMcpSpanRecorder(sentryEnv),
      performanceSpans: createPerformanceSpanRecorder(sentryEnv),
    };
    let sessionId: string | null = null;
    try {
      await Sentry.withScope(async (scope) => {
        scope.setClient(client);
        await Sentry.startSpan({ name: "POST /", op: "http.server" }, async () => {
          const response = await handleMcpServerRequest({
            ...options,
            request: rpc("initialize", null, clientName),
          });
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject({
            result: { protocolVersion: "2025-06-18" },
          });
          sessionId = response.headers.get("mcp-session-id");
          expect(sessionId).toBeTruthy();
        });
        await Sentry.startSpan({ name: "POST /", op: "http.server" }, async () => {
          expect(
            (await handleMcpServerRequest({ ...options, request: rpc("tools/list", sessionId) }))
              .status,
          ).toBe(200);
        });
      });
      await client.flush();
      const initialize = recorded.find((span) => span.name === "initialize");
      const create = recorded.find((span) => span.name === "mcp.session.create");
      expect(initialize).toBeDefined();
      expect(create?.parent_span_id).toBe(initialize?.span_id);
      for (const name of [
        "mcp.auth.bearer.verify",
        "mcp.auth.oauth.verify",
        "mcp.auth.revocation",
        "mcp.request.parse",
        "mcp.session.get",
      ]) {
        expect(recorded.some((span) => span.name === name)).toBe(true);
      }
      expect(initialize?.attributes["mcp.client.name"]).toMatchObject({ value: expected });
      const namedSpans = recorded.filter((span) => "mcp.client.name" in span.attributes);
      expect(namedSpans).toHaveLength(1);
      expect(namedSpans[0]?.name).toBe("initialize");
      if (expected === "other") expect(JSON.stringify(recorded)).not.toContain(clientName);
      expect(JSON.stringify(recorded)).not.toContain("mcp.client.version");
      expect(JSON.stringify(recorded)).not.toContain("local-test-token");
      expect(JSON.stringify(recorded)).not.toContain("private-client-version");
      expect(JSON.stringify(recorded)).not.toContain("user_local_test");
      expect(JSON.stringify(recorded)).not.toContain(sessionId);
    } finally {
      await client.close();
      if (sessionId) await sessionStore.end(sessionId, "user_local_test");
    }
  },
);

function rpc(method: string, sessionId?: string | null, clientName = "local-test-client"): Request {
  return new Request("https://mcp.test/", {
    method: "POST",
    headers: {
      authorization: "Bearer local-test-token",
      "content-type": "application/json",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: { clientInfo: { name: clientName, version: "private-client-version" } },
    }),
  });
}
