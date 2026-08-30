import { describe, expect, it, vi } from "vitest";
import { rawFailureChunks } from "./raw-event-dead-letter";
import {
  enqueueRawEvent,
  parseRawEventEnvelope,
  RAW_EVENT_QUEUE_MAX_MESSAGE_BYTES,
} from "./raw-event-queue-envelope";
import type { Env } from "./types";

describe("raw event Queue envelopes", () => {
  it("rejects an oversized row before Queue ownership", async () => {
    const send = vi.fn();
    const row = { value: "x".repeat(RAW_EVENT_QUEUE_MAX_MESSAGE_BYTES) };

    await expect(enqueueRawEvent(env(send), "raw_events", row)).rejects.toThrow(
      `raw event queue envelope exceeds ${String(RAW_EVENT_QUEUE_MAX_MESSAGE_BYTES)} bytes`,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects an oversized envelope received from an untrusted Queue message", () => {
    expect(() =>
      parseRawEventEnvelope({
        kind: "raw-event-delivery-v1",
        datasource: "raw_events",
        row: { value: "x".repeat(RAW_EVENT_QUEUE_MAX_MESSAGE_BYTES) },
      }),
    ).toThrow(
      `raw event queue envelope exceeds ${String(RAW_EVENT_QUEUE_MAX_MESSAGE_BYTES)} bytes`,
    );
  });

  it("preserves a maximum-sized admitted row with complete failure metadata", () => {
    const envelope = largestValidEnvelope();
    const message = {
      id: "message-1",
      timestamp: new Date("2026-08-30T00:00:00.000Z"),
      attempts: 1,
      body: envelope,
      ack: vi.fn(),
      retry: vi.fn(),
    } satisfies Message<Record<string, unknown>>;

    const entry = rawFailureChunks(
      [{ message, envelope, deliveryId: "queue:raw_events:message-1" }],
      { classification: "indeterminate", reason: "Tinybird returned an unreadable commit body" },
    )[0]?.[0];

    expect(entry?.bytes).toBeLessThanOrEqual(120_000);
    expect(entry?.envelope.original).toEqual(envelope);
  });
});

function largestValidEnvelope() {
  const base = {
    kind: "raw-event-delivery-v1",
    datasource: "raw_events",
    row: { value: "" },
  } as const;
  const overhead = new TextEncoder().encode(JSON.stringify(base)).byteLength;
  return parseRawEventEnvelope({
    ...base,
    row: { value: "x".repeat(RAW_EVENT_QUEUE_MAX_MESSAGE_BYTES - overhead) },
  });
}

function env(send: ReturnType<typeof vi.fn>): Env {
  return {
    RAW_EVENTS_QUEUE: {
      send,
      sendBatch: vi.fn(),
      metrics: vi.fn(),
    },
  } as Env;
}
