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
      op: "mcp.server",
      origin: "manual",
      status: "ok",
      start_timestamp: 1,
      timestamp: 2,
    });

    expect(scrubbed.span_id).toBe("0f1e2d3c4b5a6978");
    expect(scrubbed.trace_id).toBe("8877665544332211aabbccddeeff0011");
    expect(scrubbed.op).toBe("mcp.server");
    expect(scrubbed.status).toBe("ok");
    expect(scrubbed.timestamp).toBe(2);
  });

  it("preserves the MCP attribute set verbatim", () => {
    const scrubbed = scrubSentrySpan({
      data: {
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

    expect(scrubbed.data).toEqual({
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
    const data = {
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

    expect(scrubSentrySpan({ data }).data).toEqual(data);
  });

  /**
   * The dotted attribute keys Sentry's own MCP instrumentation would emit if it
   * were ever turned on. `normalize()` folds `_` and `-` but not `.`, so the PII
   * check has to split the key on dots or `mcp.request.argument.targetingKey`
   * reads as one unknown word and survives.
   */
  it("redacts a PII-named attribute even under a dotted key", () => {
    const scrubbed = scrubSentrySpan({
      data: {
        "mcp.request.argument.targetingKey": "tk-secret",
        "mcp.request.argument.email": "leak@evil.com",
        "mcp.tool.result.content": [{ text: "tk-secret" }],
      },
    });

    const data = scrubbed.data as Record<string, unknown>;
    expect(data["mcp.request.argument.targetingKey"]).toBe("[Redacted]");
    expect(data["mcp.request.argument.email"]).toBe("[Redacted]");
    expect(JSON.stringify(scrubbed).includes("tk-secret")).toBe(false);
    expect(JSON.stringify(scrubbed).includes("leak@evil.com")).toBe(false);
  });

  it("redacts a dotted attribute whose PII name is not the whole key", () => {
    const scrubbed = scrubSentrySpan({
      data: {
        "http.request.header.authorization": "Bearer leak-token",
        "url.query.targetingKey": "tk-secret",
        "http.response.status_code": 200,
      },
    });

    const data = scrubbed.data as Record<string, unknown>;
    expect(data["http.request.header.authorization"]).toBe("[Redacted]");
    expect(data["url.query.targetingKey"]).toBe("[Redacted]");
    expect(data["http.response.status_code"]).toBe(200);
  });

  /**
   * Auto-instrumented fetch spans are named after their URL, and a Targeting Key
   * rides in an evaluation path. That is why `description` is deliberately absent
   * from the span allow-list.
   */
  it("scrubs the span description rather than allowing it verbatim", () => {
    const scrubbed = scrubSentrySpan(
      { description: "GET https://api.test/v1/evaluate?targetingKey=tk-secret" },
      { extraPatterns: [/tk-secret/g] },
    );

    expect(String(scrubbed.description).includes("tk-secret")).toBe(false);
  });

  it("scrubs an unknown future span field by default", () => {
    const scrubbed = scrubSentrySpan({ someNewSpanField: { email: "leak@evil.com" } });
    expect(JSON.stringify(scrubbed).includes("leak@evil.com")).toBe(false);
  });

  it("does not throw on a minimal span", () => {
    expect(() => scrubSentrySpan({})).not.toThrow();
  });
});
