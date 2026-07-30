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

  it("scrubs API and Client Key material from Sentry and structured logs", () => {
    const apiKey = `sk_${"a".repeat(64)}`;
    const clientKey = `pk_${"b".repeat(64)}`;
    const sentryEvents: Record<string, unknown>[] = [];
    const structuredLogEvents: Record<string, unknown>[][] = [];
    const emitter = createScrubbedEmitter({
      surface: "control-panel",
      onSentryEvent: (event) => sentryEvents.push(event),
      onStructuredLogEvents: (events) => structuredLogEvents.push(events),
    });

    emitter.captureException(new Error(`credential leak ${apiKey}`), {
      credential: clientKey,
    });
    emitter.log("error", `credential leak ${clientKey}`, { credential: apiKey });

    const emitted = JSON.stringify({ sentryEvents, structuredLogEvents });
    expect(emitted).not.toContain(apiKey);
    expect(emitted).not.toContain(clientKey);
  });

  it("preserves an evaluated Variant value while scrubbing API Key material", () => {
    const apiKey = `sk_${"a".repeat(64)}`;
    const structuredLogEvents: Record<string, unknown>[][] = [];
    const emitter = createScrubbedEmitter({
      surface: "evaluation-api",
      onStructuredLogEvents: (events) => structuredLogEvents.push(events),
    });

    emitter.log("info", "Flag evaluated", {
      flagKey: "checkout-redesign",
      value: "treatment",
      reason: "TARGETING_MATCH",
      credential: apiKey,
    });

    expect(structuredLogEvents[0]?.[0]).toMatchObject({
      flagKey: "checkout-redesign",
      value: "treatment",
      reason: "TARGETING_MATCH",
      credential: "[Redacted]",
    });
  });
});
