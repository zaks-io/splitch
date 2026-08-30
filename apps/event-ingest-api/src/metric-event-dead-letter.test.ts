/**
 * The dead-letter transfer: what makes a batch poison, what the copy carries,
 * and how the copy stays inside the ceilings Cloudflare enforces on a producer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commit,
  deliver,
  metricEvent,
  queueMessage,
  seal,
  sealOne,
  stubTinybird,
} from "./metric-event-delivery-test-kit";
import { makeQueueFixture, type QueueFixture } from "./metric-event-queue-test-fixture";

let fixture: QueueFixture;

beforeEach(() => {
  fixture = makeQueueFixture();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Metric Event dead-letter transfers", () => {
  /**
   * A quarantined or short commit is a data fault, not congestion. Retrying it
   * would resend rows Tinybird already took while never fixing the bad one.
   */
  it.each([
    ["quarantined rows", { successful_rows: 1, quarantined_rows: 1 }],
    ["a short commit", { successful_rows: 1, quarantined_rows: 0 }],
  ])("dead-letters a batch Tinybird answered with %s", async (_label, body) => {
    const fetch = stubTinybird(body);
    const messages = await seal(fixture, ["event-1", "event-2"]);

    await deliver(fixture.env, messages);

    expect(fetch).toHaveBeenCalledOnce();
    expect(fixture.dlq.sendBatch).toHaveBeenCalledOnce();
    for (const message of messages) {
      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
    }
    expect(fixture.deliveryState("sha256:event-1")).toBe("poison_transferred");
  });

  it("copies the original row and the failure metadata to the dead-letter queue", async () => {
    stubTinybird({ successful_rows: 0, quarantined_rows: 1 });
    await deliver(fixture.env, await seal(fixture, ["event-1"]));

    const [sent] = fixture.dlq.sendBatch.mock.calls[0] as [
      Array<{ body: Record<string, unknown> }>,
    ];
    const envelope = sent[0]?.body as {
      kind: string;
      row: Record<string, unknown>;
      failure: Record<string, unknown>;
    };

    expect(envelope.kind, "Cloudflare copies bare rows into this same queue on its own").toBe(
      "metric-event-delivery-failure-v1",
    );
    expect(envelope.row.event_id).toBe("event-1");
    expect(envelope.failure).toMatchObject({
      datasource: "metric_events",
      dedupKey: "sha256:event-1",
      queueMessageId: "queue-event-1",
      reason: "Tinybird quarantined 1 rows",
    });
  });

  /** Acknowledging before the copy lands would destroy an accepted event. */
  it("leaves a poisoned message unacknowledged when the dead-letter copy fails", async () => {
    stubTinybird({ successful_rows: 0, quarantined_rows: 1 });
    fixture.dlq.sendBatch.mockRejectedValue(new Error("dead-letter queue is unavailable"));
    const message = await sealOne(fixture, "event-1");

    await deliver(fixture.env, [message]);

    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledOnce();
    expect(fixture.deliveryState("sha256:event-1")).toBe("poison_pending");
  });

  it("resumes the dead-letter copy on redelivery without calling Tinybird again", async () => {
    stubTinybird({ successful_rows: 0, quarantined_rows: 1 });
    fixture.dlq.sendBatch.mockRejectedValueOnce(new Error("dead-letter queue is unavailable"));
    await deliver(fixture.env, [await sealOne(fixture, "event-1")]);

    const fetch = stubTinybird(commit(1));
    const redelivered = queueMessage("event-1", 3);
    await deliver(fixture.env, [redelivered]);

    expect(fetch).not.toHaveBeenCalled();
    expect(fixture.dlq.sendBatch).toHaveBeenCalledTimes(2);
    expect(redelivered.ack).toHaveBeenCalledOnce();
    expect(fixture.deliveryState("sha256:event-1")).toBe("poison_transferred");
  });

  /**
   * Cloudflare rejects a `sendBatch` over 100 messages or 256 KB. One oversized
   * call would throw, and `transferPoisoned` would retry the whole set without
   * settling any of it, so the poisoned rows loop until the queue gives up on
   * them.
   */
  it("splits a dead-letter transfer that exceeds the Queue message ceiling", async () => {
    stubTinybird({ successful_rows: 0, quarantined_rows: 150 });
    const ids = Array.from({ length: 150 }, (_, index) => `event-${index}`);

    await deliver(fixture.env, await seal(fixture, ids));

    expect(fixture.dlq.sendBatch).toHaveBeenCalledTimes(2);
    expect(chunkSizes()).toEqual([100, 50]);
  });

  it("splits a dead-letter transfer that exceeds the Queue byte ceiling", async () => {
    stubTinybird({ successful_rows: 0, quarantined_rows: 10 });
    const ids = Array.from({ length: 10 }, (_, index) => `fat-${index}`);
    for (const id of ids) await fixture.seal(fatEvent(id));

    await deliver(
      fixture.env,
      ids.map((id) => ({ ...queueMessage(id), body: fatEvent(id) })),
    );

    expect(fixture.dlq.sendBatch.mock.calls.length).toBeGreaterThan(1);
    for (const [sent] of fixture.dlq.sendBatch.mock.calls as [{ body: unknown }[]][]) {
      expect(JSON.stringify(sent.map((entry) => entry.body)).length).toBeLessThan(240_000);
    }
  });

  /** A later chunk's failure must not cost the chunks that already landed. */
  it("settles each dead-letter chunk as it lands", async () => {
    stubTinybird({ successful_rows: 0, quarantined_rows: 150 });
    fixture.dlq.sendBatch.mockResolvedValueOnce(undefined);
    fixture.dlq.sendBatch.mockRejectedValueOnce(new Error("dead-letter queue is unavailable"));

    await deliver(
      fixture.env,
      await seal(
        fixture,
        Array.from({ length: 150 }, (_, i) => `e-${i}`),
      ),
    );

    expect(fixture.deliveryState("sha256:e-0")).toBe("poison_transferred");
    expect(fixture.deliveryState("sha256:e-149")).toBe("poison_pending");
  });
});

/** Big enough that the byte ceiling closes a chunk before the message count does. */
function fatEvent(eventId: string): Record<string, unknown> {
  return { ...metricEvent(eventId), fields: JSON.stringify({ blob: "x".repeat(30_000) }) };
}

function chunkSizes(): number[] {
  return (fixture.dlq.sendBatch.mock.calls as [unknown[]][]).map(([sent]) => sent.length);
}
