import { describe, expect, it } from "vitest";
import { scrubSentryTransaction } from "./sentry-scrubber";

/**
 * A transaction envelope as `@sentry/cloudflare` builds one: the span slice
 * (`contexts.trace`, `spans`) has already been through `beforeSendSpan`, and
 * `requestDataIntegration` has attached `request` to everything around it.
 */
function transactionEvent(): Record<string, unknown> {
  return {
    type: "transaction",
    event_id: "aabbccddeeff00112233445566778899",
    transaction: "POST /mcp",
    start_timestamp: 1,
    timestamp: 2,
    measurements: { lcp: { value: 12, unit: "millisecond" } },
    contexts: {
      trace: {
        trace_id: "8877665544332211aabbccddeeff0011",
        span_id: "0f1e2d3c4b5a6978",
        op: "http.server",
        data: { "mcp.tool.name": "flags_list" },
      },
      response: { headers: { "set-cookie": "session=COOKIE-CANARY" } },
    },
    spans: [{ span_id: "1122334455667788", op: "mcp.server", data: { "mcp.transport": "http" } }],
    request: {
      url: "https://mcp.test/mcp?targetingKey=user_7f3c9a2b@example.com",
      headers: { authorization: "Bearer SECRET-TOKEN-CANARY" },
      cookies: { session: "COOKIE-CANARY" },
      query_string: "targetingKey=user_7f3c9a2b@example.com",
    },
    breadcrumbs: [{ message: "evaluated for user_7f3c9a2b@example.com" }],
    tags: { surface: "mcp-server" },
    extra: { targetingKey: "user_7f3c9a2b@example.com" },
  };
}

describe("scrubSentryTransaction", () => {
  it("keeps the span slice the span hook already vouched for", () => {
    const scrubbed = scrubSentryTransaction(transactionEvent());

    const trace = (scrubbed.contexts as Record<string, unknown>).trace as Record<string, unknown>;
    expect(trace.trace_id).toBe("8877665544332211aabbccddeeff0011");
    expect(trace.span_id).toBe("0f1e2d3c4b5a6978");
    expect((trace.data as Record<string, unknown>)["mcp.tool.name"]).toBe("flags_list");
    expect(scrubbed.spans).toEqual([
      { span_id: "1122334455667788", op: "mcp.server", data: { "mcp.transport": "http" } },
    ]);
    expect(scrubbed.type).toBe("transaction");
    expect(scrubbed.start_timestamp).toBe(1);
    expect(scrubbed.transaction).toBe("POST /mcp");
    expect(scrubbed.measurements).toEqual({ lcp: { value: 12, unit: "millisecond" } });
  });

  /**
   * The leak this hook exists for: `beforeSend` fires for error events only, so
   * before it was wired every transaction shipped the Authorization header,
   * cookies, and the query string verbatim.
   */
  it("scrubs the request envelope the span hook never sees", () => {
    const scrubbed = scrubSentryTransaction(transactionEvent());
    const serialized = JSON.stringify(scrubbed);

    expect(serialized.includes("SECRET-TOKEN-CANARY")).toBe(false);
    expect(serialized.includes("COOKIE-CANARY")).toBe(false);
    expect(serialized.includes("user_7f3c9a2b@example.com")).toBe(false);
  });

  it("scrubs a sibling context that never went through the span hook", () => {
    const scrubbed = scrubSentryTransaction(transactionEvent());
    const contexts = scrubbed.contexts as Record<string, unknown>;

    expect(JSON.stringify(contexts.response).includes("COOKIE-CANARY")).toBe(false);
  });

  it("scrubs an unknown future transaction field by default", () => {
    const scrubbed = scrubSentryTransaction({ someNewField: { email: "leak@evil.com" } });
    expect(JSON.stringify(scrubbed).includes("leak@evil.com")).toBe(false);
  });

  it("does not throw on a minimal transaction", () => {
    expect(() => scrubSentryTransaction({ type: "transaction" })).not.toThrow();
  });
});
