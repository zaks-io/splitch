import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import type { Env } from "./types";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Metric Event queue delivery", () => {
  it("acknowledges every successfully appended message", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetch);
    const first = queueMessage("message-1", metricEvent("event-1"));
    const second = queueMessage("message-2", metricEvent("event-2"));
    const batch = messageBatch([first, second]);

    await worker.queue(batch, deliveryEnv());

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(first.ack).toHaveBeenCalledOnce();
    expect(first.retry).not.toHaveBeenCalled();
    expect(second.ack).toHaveBeenCalledOnce();
    expect(second.retry).not.toHaveBeenCalled();
    expect(batch.ackAll).not.toHaveBeenCalled();
    expect(batch.retryAll).not.toHaveBeenCalled();
  });

  it("retries a failed message without retrying its successful neighbors", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const row = JSON.parse(String(init?.body)) as { event_id: string };
      return new Response(null, { status: row.event_id === "event-bad" ? 500 : 202 });
    });
    vi.stubGlobal("fetch", fetch);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = queueMessage("message-1", metricEvent("event-good-1"));
    const failed = queueMessage("message-2", metricEvent("event-bad"));
    const third = queueMessage("message-3", metricEvent("event-good-2"));
    const batch = messageBatch([first, failed, third]);

    await worker.queue(batch, deliveryEnv());

    expect(first.ack).toHaveBeenCalledOnce();
    expect(first.retry).not.toHaveBeenCalled();
    expect(failed.ack).not.toHaveBeenCalled();
    expect(failed.retry).toHaveBeenCalledOnce();
    expect(third.ack).toHaveBeenCalledOnce();
    expect(third.retry).not.toHaveBeenCalled();
    expect(batch.ackAll).not.toHaveBeenCalled();
    expect(batch.retryAll).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("event-ingest-api Metric Event delivery failed", {
      queueMessageId: "message-2",
      attempts: 2,
      appId: "app_shop",
      environmentId: "env_prod",
      eventId: "event-bad",
      eventDefinitionId: "event_definition_checkout",
      errorMessage: "Tinybird append failed with HTTP 500",
    });
  });

  it("retries each message and identifies it when delivery configuration is unavailable", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = queueMessage("message-1", metricEvent("event-1"));
    const second = queueMessage("message-2", metricEvent("event-2"));
    const batch = messageBatch([first, second]);

    await worker.queue(batch, {});

    expect(fetch).not.toHaveBeenCalled();
    expect(first.ack).not.toHaveBeenCalled();
    expect(first.retry).toHaveBeenCalledOnce();
    expect(second.ack).not.toHaveBeenCalled();
    expect(second.retry).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(
      "event-ingest-api Metric Event delivery failed",
      expect.objectContaining({ queueMessageId: "message-1", eventId: "event-1" }),
    );
    expect(error).toHaveBeenCalledWith(
      "event-ingest-api Metric Event delivery failed",
      expect.objectContaining({ queueMessageId: "message-2", eventId: "event-2" }),
    );
  });
});

function metricEvent(eventId: string): Record<string, unknown> {
  return {
    event_id: eventId,
    app_id: "app_shop",
    environment_id: "env_prod",
    event_definition_id: "event_definition_checkout",
    fields: JSON.stringify({ converted: true, email: "private@example.com" }),
  };
}

function queueMessage(id: string, body: Record<string, unknown>) {
  return {
    id,
    timestamp: new Date("2026-08-07T00:00:00.000Z"),
    body,
    attempts: 2,
    ack: vi.fn(),
    retry: vi.fn(),
  } satisfies Message<Record<string, unknown>>;
}

function messageBatch(messages: readonly ReturnType<typeof queueMessage>[]) {
  return {
    messages,
    queue: "metric-events",
    metadata: { metrics: { backlogCount: 3, backlogBytes: 1024 } },
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } satisfies MessageBatch<Record<string, unknown>>;
}

function deliveryEnv(): Env {
  return {
    TINYBIRD_API_URL: "https://tinybird.test",
    TINYBIRD_INGEST_TOKEN: "test-token",
  };
}
