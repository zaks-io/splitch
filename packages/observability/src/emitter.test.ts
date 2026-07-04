import { beforeEach, describe, expect, it, vi } from "vitest";

import { createScrubbedEmitter } from "./emitter.js";

describe("createScrubbedEmitter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits scrubbed structured log events without vendor token flushing", () => {
    const structuredLogEvents: Record<string, unknown>[][] = [];
    const emitter = createScrubbedEmitter({
      surface: "test-worker",
      onStructuredLogEvents: (events) => {
        structuredLogEvents.push(events);
      },
    });

    emitter.log("info", "request", { requestId: "req-1", email: "leak@example.com" });

    expect(structuredLogEvents).toHaveLength(1);
    expect(structuredLogEvents[0]?.[0]).toMatchObject({
      level: "info",
      message: "request",
      requestId: "req-1",
      email: "[Redacted]",
    });
  });

  it("invokes onSentryCaptureException after scrubbing extras", () => {
    const captured: Array<{ error: unknown; extra: Record<string, unknown> }> = [];
    const emitter = createScrubbedEmitter({
      surface: "cli",
      sentryDsn: "https://example@sentry.io/1",
      onSentryCaptureException: (error, extra) => {
        captured.push({ error, extra });
      },
    });

    emitter.captureException(new Error("boom"), {
      targeting: { email: "leak@example.com" },
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.extra.targeting).toBe("[Redacted]");
  });
});
