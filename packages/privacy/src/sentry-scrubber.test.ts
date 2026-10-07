import { describe, expect, it } from "vitest";
import { scrubSentryEvent, scrubSentrySpan } from "./sentry-scrubber";

describe("scrubSentryEvent allow-list traversal", () => {
  it("scrubs an unknown future field by default (fail-safe, not leak-by-default)", () => {
    // A field this scrubber has never heard of must still be redacted.
    const scrubbed = scrubSentryEvent({ someNewSentryField: { email: "leak@evil.com" } });
    expect(JSON.stringify(scrubbed).includes("leak@evil.com")).toBe(false);
  });

  it("preserves allow-listed operational fields verbatim", () => {
    const scrubbed = scrubSentryEvent({
      event_id: "evt_1",
      level: "error",
      tags: { app_id: "app_1" },
      user: { id: "operator-7" },
      transaction: "GET /x",
    });
    expect(scrubbed.event_id).toBe("evt_1");
    expect(scrubbed.level).toBe("error");
    expect((scrubbed.tags as { app_id: string }).app_id).toBe("app_1");
    expect((scrubbed.user as { id: string }).id).toBe("operator-7");
    expect(scrubbed.transaction).toBe("GET /x");
  });

  it("preserves error trace identity while scrubbing trace attributes and sibling contexts", () => {
    const trace = {
      trace_id: "0123456789abcdef0123456789abcdef",
      span_id: "0123456789012345",
      parent_span_id: "1234567890123456",
      op: "http.server",
      data: { "http.request.method": "GET", targetingKey: "customer-secret" },
      futureField: { email: "leak@evil.com" },
    };
    const scrubbed = scrubSentryEvent({
      contexts: { trace, custom: { targetingKey: "customer-secret", email: "leak@evil.com" } },
    });

    expect(scrubbed.contexts.trace).toEqual({
      ...trace,
      data: { "http.request.method": "GET", targetingKey: "[Redacted]" },
      futureField: { email: "[Redacted]" },
    });
    expect(scrubbed.contexts.custom).toEqual({
      targetingKey: "[Redacted]",
      email: "[Redacted]",
    });
    expect(trace.data.targetingKey).toBe("customer-secret");
  });

  it.each([null, "email@evil.com", ["email@evil.com"]])(
    "scrubs malformed trace contexts: %j",
    (trace) => {
      const scrubbed = scrubSentryEvent({ contexts: { trace } });
      expect(JSON.stringify(scrubbed)).not.toContain("email@evil.com");
    },
  );

  it("scrubs PII inside tags while preserving safe operational tags", () => {
    const scrubbed = scrubSentryEvent(
      {
        tags: {
          appId: "app_1",
          orgId: "org_1",
          role: "admin",
          targetingKey: "tk-secret",
          email: "leak@evil.com",
          context: { plan: "enterprise-secret-plan" },
        },
      },
      { extraPatterns: [/tk-secret/g] },
    );

    const tags = scrubbed.tags as Record<string, unknown>;
    expect(tags.appId).toBe("app_1");
    expect(tags.orgId).toBe("org_1");
    expect(tags.role).toBe("admin");
    expect(tags.targetingKey).toBe("[Redacted]");
    expect(tags.email).toBe("[Redacted]");
    expect(tags.context).toBe("[Redacted]");

    const serialized = JSON.stringify(scrubbed);
    expect(serialized.includes("tk-secret")).toBe(false);
    expect(serialized.includes("leak@evil.com")).toBe(false);
    expect(serialized.includes("enterprise-secret-plan")).toBe(false);
  });

  it("scrubs fingerprint values instead of allowing the whole field verbatim", () => {
    const scrubbed = scrubSentryEvent(
      {
        fingerprint: [
          "{{ default }}",
          "tk-secret",
          { context: { plan: "enterprise-secret-plan" } },
        ],
      },
      { extraPatterns: [/tk-secret/g] },
    );

    expect(scrubbed.fingerprint).toEqual([
      "{{ default }}",
      "[Redacted]",
      { context: "[Redacted]" },
    ]);
    const serialized = JSON.stringify(scrubbed);
    expect(serialized.includes("tk-secret")).toBe(false);
    expect(serialized.includes("enterprise-secret-plan")).toBe(false);
  });

  it("traverses request.data, cookies, and headers", () => {
    const scrubbed = scrubSentryEvent({
      request: {
        data: { email: "leak@evil.com" },
        cookies: { sid: "abc" },
        headers: { authorization: "Bearer x" },
      },
    });
    expect(JSON.stringify(scrubbed.request).includes("leak@evil.com")).toBe(false);
    expect(JSON.stringify(scrubbed.request).includes("abc")).toBe(false);
    expect(JSON.stringify(scrubbed.request).includes("Bearer x")).toBe(false);
  });

  it("traverses the top-level message", () => {
    const scrubbed = scrubSentryEvent({
      message: `boom ${JSON.stringify({ email: "leak@evil.com" })}`,
    });
    expect(String(scrubbed.message).includes("leak@evil.com")).toBe(false);
  });

  it("keeps ONLY user.id; scrubs user.email / user.ip_address / user.username", () => {
    const scrubbed = scrubSentryEvent({
      user: {
        id: "operator-42",
        email: "user-canary@example.com",
        ip_address: "203.0.113.7",
        username: "end-user-canary",
      },
    });
    const user = scrubbed.user as Record<string, unknown>;
    expect(user.id).toBe("operator-42");
    expect(user.email).toBe("[Redacted]");
    expect(user.ip_address).toBe("[Redacted]");
    expect(user.username).toBe("[Redacted]");
    const serialized = JSON.stringify(scrubbed);
    expect(serialized.includes("user-canary@example.com")).toBe(false);
    expect(serialized.includes("203.0.113.7")).toBe(false);
    expect(serialized.includes("end-user-canary")).toBe(false);
  });

  it("rejects a transaction envelope rather than bypassing the streamed span policy", () => {
    expect(() =>
      scrubSentryEvent({ type: "transaction", extra: { targetingKey: "private" } }),
    ).toThrow("Sentry transaction events are unsupported");
  });

  it("does not throw on a minimal event", () => {
    expect(() => scrubSentryEvent({})).not.toThrow();
  });
});

describe("scrubSentrySpan allow-list traversal", () => {
  it("preserves span identity and timing fields verbatim", () => {
    const scrubbed = scrubSentrySpan({
      span_id: "0f1e2d3c4b5a6978",
      parent_span_id: "1122334455667788",
      trace_id: "8877665544332211aabbccddeeff0011",
      attributes: { "sentry.op": "mcp.server", "sentry.origin": "manual" },
      is_segment: true,
      status: "ok",
      start_timestamp: 1,
      end_timestamp: 2,
    });

    expect(scrubbed.span_id).toBe("0f1e2d3c4b5a6978");
    expect(scrubbed.trace_id).toBe("8877665544332211aabbccddeeff0011");
    expect(scrubbed.attributes["sentry.op"]).toBe("mcp.server");
    expect(scrubbed.is_segment).toBe(true);
    expect(scrubbed.status).toBe("ok");
    expect(scrubbed.end_timestamp).toBe(2);
  });

  it("preserves required streamed protocol attributes while scrubbing segment names", () => {
    const attributes = {
      "sentry.segment.id": "0123456789012345",
      "sentry.segment.name": "GET",
      "sentry.environment": "shared-preview",
      "sentry.release": "splitch-control-panel@abc123",
      "sentry.sdk.name": "sentry.javascript.cloudflare",
      "sentry.sdk.version": "11.4.0",
      "sentry.sdk.integrations": ["SplitchPrivacy"],
      "sentry.trace_lifecycle": "stream",
    };
    expect(scrubSentrySpan({ attributes }).attributes).toEqual(attributes);
    expect(
      scrubSentrySpan({
        attributes: { ...attributes, "sentry.segment.name": "error leak@evil.com" },
      }).attributes["sentry.segment.name"],
    ).not.toContain("leak@evil.com");
    expect(
      scrubSentrySpan({
        attributes: {
          ...attributes,
          "sentry.op": "http.client",
          "sentry.segment.name": "GET https://upstream.test?cohort=private",
        },
      }).attributes["sentry.segment.name"],
    ).toBe("[Redacted]");
  });

  it("preserves the MCP attribute set verbatim", () => {
    const scrubbed = scrubSentrySpan({
      attributes: {
        "mcp.method.name": "tools/call",
        "mcp.tool.name": "flags_list",
        "mcp.resource.uri": "splitch://quickstart",
        "mcp.prompt.name": "diagnose_setup",
        "mcp.transport": "http",
        "network.transport": "tcp",
        "mcp.tool.result.is_error": false,
        "mcp.tool.result.content_count": 1,
      },
    });

    expect(scrubbed.attributes).toEqual({
      "mcp.method.name": "tools/call",
      "mcp.tool.name": "flags_list",
      "mcp.resource.uri": "splitch://quickstart",
      "mcp.prompt.name": "diagnose_setup",
      "mcp.transport": "http",
      "network.transport": "tcp",
      "mcp.tool.result.is_error": false,
      "mcp.tool.result.content_count": 1,
    });
  });

  it("preserves only payload-free performance attributes verbatim", () => {
    const attributes = {
      "db.system": "tinybird",
      "db.operation.name": "read",
      "db.response.returned_rows": 4,
      "http.request.method": "POST",
      "http.response.status_code": 200,
      "rpc.system": "cloudflare.service_binding",
      "rpc.method": "overview_get",
      "rpc.response.status_code": 200,
      "tinybird.pipe.name": "analysis_run_bootstrap",
      "panel.app.count": 2,
      "panel.environment.count": 3,
      "panel.membership.count": 2,
      "session.pending_resync": false,
      "session.resync_attempted": false,
      "session.resync_succeeded": false,
      "auth.result": "ok",
    };

    expect(scrubSentrySpan({ attributes }).attributes).toEqual(attributes);
  });
});

describe("scrubSentrySpan redaction", () => {
  /**
   * The dotted attribute keys Sentry's own MCP instrumentation would emit if it
   * were ever turned on. `normalize()` folds `_` and `-` but not `.`, so the PII
   * check has to split the key on dots or `mcp.request.argument.targetingKey`
   * reads as one unknown word and survives.
   */
  it("redacts a PII-named attribute even under a dotted key", () => {
    const scrubbed = scrubSentrySpan({
      attributes: {
        "mcp.request.argument.targetingKey": "tk-secret",
        "mcp.request.argument.email": "leak@evil.com",
        "mcp.tool.result.content": [{ text: "tk-secret" }],
      },
    });

    const attributes = scrubbed.attributes as Record<string, unknown>;
    expect(attributes["mcp.request.argument.targetingKey"]).toBe("[Redacted]");
    expect(attributes["mcp.request.argument.email"]).toBe("[Redacted]");
    expect(JSON.stringify(scrubbed).includes("tk-secret")).toBe(false);
    expect(JSON.stringify(scrubbed).includes("leak@evil.com")).toBe(false);
  });

  it("redacts a dotted attribute whose PII name is not the whole key", () => {
    const scrubbed = scrubSentrySpan({
      attributes: {
        "http.request.header.authorization": "Bearer leak-token",
        "url.query.targetingKey": "tk-secret",
        "http.response.status_code": 200,
      },
    });

    const attributes = scrubbed.attributes as Record<string, unknown>;
    expect(attributes["http.request.header.authorization"]).toBe("[Redacted]");
    expect(attributes["url.query.targetingKey"]).toBe("[Redacted]");
    expect(attributes["http.response.status_code"]).toBe(200);
  });

  it("redacts auto-instrumented fetch URLs even when their IDs do not match PII patterns", () => {
    const scrubbed = scrubSentrySpan({
      name: "GET https://api.tinybird.co/v0/pipes/results.json?app_id=app_123&environment_id=env_456",
      attributes: {
        "sentry.op": "http.client",
        url: "https://api.tinybird.co/v0/pipes/results.json?app_id=app_123&environment_id=env_456",
        "http.url":
          "https://api.tinybird.co/v0/pipes/results.json?app_id=app_123&environment_id=env_456",
        "url.full":
          "https://api.tinybird.co/v0/pipes/results.json?app_id=app_123&environment_id=env_456",
        "http.query": "?app_id=app_123&environment_id=env_456",
        "server.address": "api.tinybird.co",
        "http.request.method": "GET",
      },
    });

    expect(JSON.stringify(scrubbed).includes("app_123")).toBe(false);
    expect(JSON.stringify(scrubbed).includes("env_456")).toBe(false);
    expect(scrubbed.name).toBe("[Redacted]");
    expect((scrubbed.attributes as Record<string, unknown>)["http.request.method"]).toBe("GET");
  });

  it("keeps the closed-vocabulary name of a non-HTTP manual span", () => {
    expect(
      scrubSentrySpan({ attributes: { "sentry.op": "db.query" }, name: "tinybird.pipe.read" }).name,
    ).toBe("tinybird.pipe.read");
  });

  it("scrubs an unknown future span field by default", () => {
    const scrubbed = scrubSentrySpan({ someNewSpanField: { email: "leak@evil.com" } });
    expect(JSON.stringify(scrubbed).includes("leak@evil.com")).toBe(false);
  });

  it("does not throw on a minimal span", () => {
    expect(() => scrubSentrySpan({})).not.toThrow();
  });
});
