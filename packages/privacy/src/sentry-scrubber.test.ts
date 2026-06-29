import { describe, expect, it } from "vitest";
import { scrubSentryEvent } from "./sentry-scrubber.js";

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

  it("traverses request.data, cookies, and headers", () => {
    const scrubbed = scrubSentryEvent({
      request: {
        data: { email: "leak@evil.com" },
        cookies: { sid: "abc" },
        headers: { authorization: "Bearer x" },
      },
    });
    expect(JSON.stringify(scrubbed.request).includes("leak@evil.com")).toBe(false);
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
