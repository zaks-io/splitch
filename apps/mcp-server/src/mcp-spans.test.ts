import {
  mcpSpanAttributes,
  mcpSpanName,
  type McpSpanDescriptor,
  type McpSpanHandle,
  type McpSpanRecorder,
} from "@splitch/observability/mcp-spans";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleMcpServerRequest, type McpServerRequestOptions } from "./mcp-handler";
import { memorySessionStore } from "./mcp-oauth-prm-harness";
import {
  allowMcpRevocations,
  staticMcpTokenVerifier,
  TEST_MCP_DELEGATION_SECRET,
} from "./mcp-test-verifier";

/**
 * A Targeting Key and an Evaluation Context attribute, planted in tool arguments
 * that the server passes straight through. Neither may appear anywhere in a span:
 * spans ship to Sentry, and ADR-0032 puts subject identifiers out of bounds there.
 */
const TARGETING_KEY_CANARY = "user_7f3c9a2b@example.com";
const CONTEXT_CANARY = "canary-plan-enterprise";

const sessionStore = memorySessionStore();

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MCP protocol spans", () => {
  it("names a tool call and carries the Sentry MCP attribute set", async () => {
    const spans = recordingSpans();
    await rpc(
      "tools/call",
      { name: "flags_list", arguments: { appId: "app_local" } },
      { spans, withFetch: true },
    );

    expect(spans.recorded).toHaveLength(1);
    const span = spans.recorded[0];
    expect(span?.name).toBe("tools/call flags_list");
    expect(Object.keys(span?.attributes ?? {}).sort()).toEqual([
      "mcp.method.name",
      "mcp.tool.name",
      "mcp.tool.result.content_count",
      "mcp.tool.result.is_error",
      "mcp.transport",
      "network.transport",
    ]);
    expect(span?.attributes).toMatchObject({
      "mcp.method.name": "tools/call",
      "mcp.tool.name": "flags_list",
      "mcp.transport": "http",
      "network.transport": "tcp",
      "mcp.tool.result.is_error": false,
      "mcp.tool.result.content_count": 1,
    });
  });

  it("labels a caller-fixable refusal as an errored tool result", async () => {
    const spans = recordingSpans();
    await rpc(
      "tools/call",
      { name: "organizations_get", arguments: {} },
      { spans, withFetch: true },
    );

    expect(spans.recorded[0]?.attributes).toMatchObject({
      "mcp.tool.name": "organizations_get",
      "mcp.tool.result.is_error": true,
    });
  });

  it("labels a thrown fault as an errored tool result", async () => {
    const spans = recordingSpans();
    await rpc(
      "tools/call",
      { name: "organizations_get", arguments: { orgId: "org_local" } },
      { spans, withSecret: false, withFetch: true },
    );

    expect(spans.recorded[0]?.attributes).toMatchObject({
      "mcp.tool.name": "organizations_get",
      "mcp.tool.result.is_error": true,
    });
  });

  it("names the resource on a read and the prompt on a get", async () => {
    const spans = recordingSpans();
    await rpc("resources/read", { uri: "splitch://quickstart" }, { spans });
    await rpc(
      "prompts/get",
      { name: "diagnose_setup", arguments: { flagKey: "checkout" } },
      {
        spans,
      },
    );

    expect(spans.recorded.map((span) => span.name)).toEqual([
      "resources/read splitch://quickstart",
      "prompts/get diagnose_setup",
    ]);
    expect(spans.recorded[0]?.attributes).toMatchObject({
      "mcp.method.name": "resources/read",
      "mcp.resource.uri": "splitch://quickstart",
    });
    expect(spans.recorded[1]?.attributes).toMatchObject({
      "mcp.method.name": "prompts/get",
      "mcp.prompt.name": "diagnose_setup",
    });
  });

  it("names a method with no subject after the method alone", async () => {
    const spans = recordingSpans();
    await rpc("tools/list", {}, { spans });

    expect(spans.recorded[0]?.name).toBe("tools/list");
    expect(Object.keys(spans.recorded[0]?.attributes ?? {}).sort()).toEqual([
      "mcp.method.name",
      "mcp.transport",
      "network.transport",
    ]);
  });

  it("carries the session id when the call runs inside a session", async () => {
    const spans = recordingSpans();
    const sessionId = await sessionStore.create("user_local_test", { authDoor: "id_jag" });
    await rpc("tools/list", {}, { spans, sessionId });

    expect(spans.recorded[0]?.attributes["mcp.session.id"]).toBe(sessionId);
  });

  /**
   * `params.uri`, `params.name`, and the tool name are unvalidated caller strings
   * at the point the span is opened. `mcp.resource.uri`, `mcp.prompt.name`, and
   * `mcp.tool.name` are attributes the scrubber allow-lists BY NAME, so a subject
   * taken verbatim would carry caller text straight through to Sentry -- and give
   * the span name unbounded cardinality besides. Resolve it against the registry
   * or drop it.
   */
  it("drops a subject that names nothing in the registry", async () => {
    const spans = recordingSpans();
    await rpc(
      "resources/read",
      { uri: `splitch://quickstart?targetingKey=${TARGETING_KEY_CANARY}` },
      { spans },
    );
    await rpc("prompts/get", { name: TARGETING_KEY_CANARY }, { spans });
    await rpc(
      "tools/call",
      { name: `flags_list?leak=${TARGETING_KEY_CANARY}`, arguments: {} },
      { spans, withFetch: true },
    );

    expect(spans.recorded.map((span) => span.name)).toEqual([
      "resources/read",
      "prompts/get",
      "tools/call",
    ]);
    expect(JSON.stringify(spans.recorded)).not.toContain(TARGETING_KEY_CANARY);
    // An unknown tool is still a failed tool call, so the span says so.
    expect(spans.recorded[2]?.attributes["mcp.tool.result.is_error"]).toBe(true);
  });

  /**
   * The regression guard on the privacy decision. Sentry's own MCP
   * instrumentation records `mcp.request.argument.*` and tool result content, both
   * gated behind opt-in flags precisely because they carry caller data. This
   * server never opts in, so the arguments must not survive the span at all --
   * not under a different key, not inside the span name.
   */
  it("keeps tool arguments and result content out of the span entirely", async () => {
    const spans = recordingSpans();
    await rpc(
      "tools/call",
      {
        name: "flags_list",
        arguments: {
          appId: "app_local",
          targetingKey: TARGETING_KEY_CANARY,
          context: { plan: CONTEXT_CANARY },
        },
      },
      { spans, withFetch: true },
    );

    const serialized = JSON.stringify(spans.recorded);
    expect(serialized).not.toContain(TARGETING_KEY_CANARY);
    expect(serialized).not.toContain(CONTEXT_CANARY);
    expect(serialized).not.toContain("mcp.request.argument");
    expect(serialized).not.toContain("mcp.request.id");
    expect(serialized).not.toContain('mcp.tool.result.content"');
  });
});

describe("MCP fault reporting", () => {
  it("reports a thrown fault and hands back its reference", async () => {
    const faults: unknown[] = [];
    const body = await rpc(
      "tools/call",
      { name: "organizations_get", arguments: { orgId: "org_local" } },
      {
        withSecret: false,
        withFetch: true,
        reportFault: (error) => {
          faults.push(error);
          return "trace-abc";
        },
      },
    );

    expect(faults).toHaveLength(1);
    expect(body).toMatchObject({
      error: { code: -32603, data: { reference: "trace-abc" } },
    });
  });

  it("does not report a caller-fixable refusal", async () => {
    const faults: unknown[] = [];
    await rpc(
      "tools/call",
      { name: "organizations_get", arguments: {} },
      {
        withFetch: true,
        reportFault: (error) => {
          faults.push(error);
          return "trace-abc";
        },
      },
    );

    expect(faults).toEqual([]);
  });
});

interface RecordedSpan {
  readonly name: string;
  readonly attributes: Record<string, unknown>;
}

/**
 * Mirrors `createMcpSpanRecorder` by calling the same two shape helpers the real
 * recorder feeds to `startSpan`, so an attribute added there shows up here rather
 * than passing a test written against a hand-copied list.
 */
function recordingSpans(): McpSpanRecorder & { readonly recorded: RecordedSpan[] } {
  const recorded: RecordedSpan[] = [];
  return {
    recorded,
    record<T>(descriptor: McpSpanDescriptor, run: (span: McpSpanHandle) => Promise<T>): Promise<T> {
      const attributes: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(mcpSpanAttributes(descriptor))) {
        if (value !== undefined) {
          attributes[key] = value;
        }
      }
      recorded.push({ name: mcpSpanName(descriptor), attributes });
      return run({
        setToolResult({ isError, contentCount }) {
          attributes["mcp.tool.result.is_error"] = isError;
          attributes["mcp.tool.result.content_count"] = contentCount;
        },
      });
    },
  };
}

interface ProbeOptions {
  readonly spans?: McpSpanRecorder;
  readonly reportFault?: McpServerRequestOptions["reportFault"];
  readonly sessionId?: string;
  readonly withSecret?: boolean;
  readonly withFetch?: boolean;
}

async function rpc(method: string, params: unknown, options: ProbeOptions = {}): Promise<unknown> {
  const response = await handleMcpServerRequest({
    request: new Request("https://mcp.test/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer local-test-token",
        "content-type": "application/json",
        ...(options.sessionId ? { "mcp-session-id": options.sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    service: "splitch-mcp-server",
    platformTarget: "local",
    tokenVerifier: staticMcpTokenVerifier(),
    revocations: allowMcpRevocations(),
    sessionStore,
    ...(options.spans ? { spans: options.spans } : {}),
    ...(options.reportFault ? { reportFault: options.reportFault } : {}),
    ...(options.withSecret === false
      ? {}
      : { controlPlaneDelegationSecret: TEST_MCP_DELEGATION_SECRET }),
    ...(options.withFetch
      ? {
          controlPlaneFetch: async () =>
            Response.json({ items: [], readLimit: 200, readTruncated: false, cursor: null }),
        }
      : {}),
  });
  return await response.json();
}
