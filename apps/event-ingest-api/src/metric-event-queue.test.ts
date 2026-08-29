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

    await deliver(batch, deliveryEnv());

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

    await deliver(batch, deliveryEnv());

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
      maxRetries: 7,
      ...identityOf("event-bad"),
      errorMessage: "Tinybird append failed with HTTP 500",
    });
  });

  it("logs the complete Metric Event identity when its final failed attempt is discarded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = queueMessage("message-final-attempt", metricEvent("event-discarded"), 8);

    await deliver(messageBatch([failed]), deliveryEnv());

    expect(failed.ack).not.toHaveBeenCalled();
    expect(failed.retry).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      "event-ingest-api Metric Event discarded after final delivery attempt",
      {
        queueMessageId: "message-final-attempt",
        attempts: 8,
        maxRetries: 7,
        ...identityOf("event-discarded"),
        errorMessage: "Tinybird append failed with HTTP 500",
      },
    );
  });

  it("keeps a malformed row's identity intact instead of dropping the odd field", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const malformed = metricEvent("event-malformed");
    malformed.event_definition_version_id = 42;
    malformed.targeting_key_hash = { unexpected: "shape" };
    delete malformed.dedup_key;
    const failed = queueMessage("message-malformed", malformed, 8);

    await deliver(messageBatch([failed]), deliveryEnv());

    expect(error).toHaveBeenCalledWith(
      "event-ingest-api Metric Event discarded after final delivery attempt",
      {
        queueMessageId: "message-malformed",
        attempts: 8,
        maxRetries: 7,
        ...identityOf("event-malformed"),
        dedupKey: "<absent>",
        eventDefinitionVersionId: "42",
        targetingKeyHash: '{"unexpected":"shape"}',
        errorMessage: "Tinybird append failed with HTTP 500",
      },
    );
  });

  it("retries each message and identifies it when delivery configuration is unavailable", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = queueMessage("message-1", metricEvent("event-1"));
    const second = queueMessage("message-2", metricEvent("event-2"));
    const batch = messageBatch([first, second]);

    await deliver(batch, { SPLITCH_PLATFORM_TARGET: "local" });

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

  it("acknowledges a suppressed queued retry without re-appending it", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const message = queueMessage("message-deleted", {
      ...metricEvent("event-deleted"),
      entity_family_hash: "v1:deleted-family",
    });
    const env = deliveryEnv();
    env.ENTITY_METRIC_PRIVACY = {
      idFromName: () => ({}) as DurableObjectId,
      get: () => ({ fetch: async () => Response.json({ suppressed: true }) }),
    };

    await deliver(messageBatch([message]), env);

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

function metricEvent(eventId: string): Record<string, unknown> {
  return {
    dedup_key: `sha256:${eventId}`,
    event_id: eventId,
    app_id: "app_shop",
    environment_id: "env_prod",
    event_definition_id: "event_definition_checkout",
    event_definition_version_id: "event_definition_version_checkout_3",
    event_name: "checkout_completed",
    id_type: "user",
    targeting_key_hash: `v1:${eventId}-targeting-key`,
    fields: JSON.stringify({ converted: true, email: "private@example.com" }),
    dimensions: JSON.stringify({ plan: "pro" }),
    server_received_at: "2026-08-07T00:00:00.000Z",
  };
}

/** What the discard log must carry for the row `metricEvent` builds. */
function identityOf(eventId: string): Record<string, string> {
  return {
    appId: "app_shop",
    environmentId: "env_prod",
    eventId,
    dedupKey: `sha256:${eventId}`,
    eventDefinitionId: "event_definition_checkout",
    eventDefinitionVersionId: "event_definition_version_checkout_3",
    eventName: "checkout_completed",
    idType: "user",
    targetingKeyHash: `v1:${eventId}-targeting-key`,
    serverReceivedAt: "2026-08-07T00:00:00.000Z",
    // Tinybird stamps `ingest_ts` at append time, so the queue message never carries one.
    ingestTs: "<absent>",
  };
}

function queueMessage(id: string, body: Record<string, unknown>, attempts = 2) {
  return {
    id,
    timestamp: new Date("2026-08-07T00:00:00.000Z"),
    body,
    attempts,
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
    SPLITCH_PLATFORM_TARGET: "local",
    TINYBIRD_API_URL: "https://tinybird.test",
    TINYBIRD_INGEST_TOKEN: "test-token",
  };
}

async function deliver(batch: MessageBatch<Record<string, unknown>>, env: Env): Promise<void> {
  if (!worker.queue) {
    throw new Error("Event ingest queue handler is not configured");
  }

  await worker.queue(batch, env, {} as ExecutionContext);
}
