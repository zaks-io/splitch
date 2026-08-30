import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commit,
  deliver,
  metricEvent,
  queueMessage,
  seal,
  sealOne,
  stubTinybird,
  suppress,
  type TinybirdStub,
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

describe("Metric Event Tinybird microbatches", () => {
  /**
   * The reason this consumer exists. Tinybird documents its append ceiling as
   * 100 requests per second per data source, so one request per row means a
   * single full consumer batch spends the whole second's budget.
   */
  it("sends one Tinybird request for a whole batch instead of one per row", async () => {
    const fetch = stubTinybird(commit(3));
    const messages = await seal(fixture, ["event-1", "event-2", "event-3"]);

    await deliver(fixture.env, messages);

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = firstCall(fetch);
    expect(new URL(url).searchParams.get("name")).toBe("metric_events");
    expect(new URL(url).searchParams.get("wait")).toBe("true");
    expect(headerOf(init, "content-encoding")).toBe("gzip");
    expect(headerOf(init, "content-type")).toBe("application/x-ndjson");
    for (const message of messages) expect(message.ack).toHaveBeenCalledOnce();
  });

  it("carries every row of the batch as newline-delimited JSON", async () => {
    const fetch = stubTinybird(commit(3));
    await deliver(fixture.env, await seal(fixture, ["event-1", "event-2", "event-3"]));

    const lines = await ndjsonOf(fetch);

    expect(lines).toHaveLength(3);
    expect(lines.map((row) => row.event_id)).toEqual(["event-1", "event-2", "event-3"]);
  });

  /**
   * Every settle targets a different per-dedup-key object, so awaiting them one
   * at a time gave a full batch a hundred serial round trips: the same per-row
   * cost the microbatch exists to remove, moved from Tinybird to the outbox.
   */
  it("settles a batch's write-ahead records concurrently", async () => {
    stubTinybird(commit(3));
    const peak = trackSettleConcurrency();

    await deliver(fixture.env, await seal(fixture, ["event-1", "event-2", "event-3"]));

    expect(peak()).toBeGreaterThan(1);
  });

  it("retries only the row whose write-ahead settlement failed", async () => {
    const fetch = stubTinybird(commit(2));
    failSettleFor("sha256:event-2");
    const messages = await seal(fixture, ["event-1", "event-2"]);

    await deliver(fixture.env, messages);

    expect(fetch).toHaveBeenCalledOnce();
    expect(messages[0]?.ack).toHaveBeenCalledOnce();
    expect(messages[0]?.retry).not.toHaveBeenCalled();
    expect(messages[1]?.ack).not.toHaveBeenCalled();
    expect(messages[1]?.retry).toHaveBeenCalledOnce();
    expect(fixture.deliveryState("sha256:event-1")).toBe("delivered");
    expect(fixture.deliveryState("sha256:event-2")).toBe("attempting");
  });

  it("records a delivered write-ahead state for every acknowledged row", async () => {
    stubTinybird(commit(2));
    await deliver(fixture.env, await seal(fixture, ["event-1", "event-2"]));

    expect(fixture.deliveryState("sha256:event-1")).toBe("delivered");
    expect(fixture.deliveryState("sha256:event-2")).toBe("delivered");
  });

  it("honors Retry-After on a rate-limited batch and retries every message", async () => {
    stubTinybird(undefined, { status: 429, headers: { "retry-after": "12" } });
    const messages = await seal(fixture, ["event-1", "event-2"]);

    await deliver(fixture.env, messages);

    for (const message of messages) {
      expect(message.ack).not.toHaveBeenCalled();
      expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 12 });
    }
    expect(fixture.deliveryState("sha256:event-1")).toBe("retryable");
    expect(fixture.dlq.sendBatch).not.toHaveBeenCalled();
  });

  /**
   * `Retry-After` may be an HTTP date arbitrarily far out. Queues rejects a
   * `delaySeconds` past 86,400 by throwing, which would cost the message the
   * very attempt the header was asking us to postpone.
   */
  it("caps an upstream Retry-After at a delay Queues will accept", async () => {
    const farFuture = new Date(Date.now() + 30 * 86_400 * 1000).toUTCString();
    stubTinybird(undefined, { status: 429, headers: { "retry-after": farFuture } });
    const message = await sealOne(fixture, "event-1");

    await deliver(fixture.env, [message]);

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 43_200 });
  });

  /**
   * A 422 means a materialized view interrupted ingestion, so retrying can
   * duplicate committed rows and discarding can lose uncommitted ones. The
   * durable record is the handoff to reconciliation.
   */
  it("parks a 422 batch as indeterminate rather than retrying it", async () => {
    stubTinybird(undefined, { status: 422 });
    const messages = await seal(fixture, ["event-1"]);

    await deliver(fixture.env, messages);

    expect(messages[0]?.retry).not.toHaveBeenCalled();
    expect(messages[0]?.ack).toHaveBeenCalledOnce();
    expect(fixture.deliveryState("sha256:event-1")).toBe("indeterminate");
  });

  it("excludes a privacy-deleted row from the request and acknowledges it", async () => {
    const row = metricEvent("event-2");
    await fixture.seal(metricEvent("event-1"));
    await fixture.seal(row);
    await suppress(fixture.env, row);
    const fetch = stubTinybird(commit(1));
    const messages = [queueMessage("event-1"), queueMessage("event-2")];

    await deliver(fixture.env, messages);

    const lines = await ndjsonOf(fetch);
    expect(lines.map((entry) => entry.event_id)).toEqual(["event-1"]);
    for (const message of messages) expect(message.ack).toHaveBeenCalledOnce();
  });
});

/** Reports the most settle requests that were ever in flight at once. */
function trackSettleConcurrency(): () => number {
  const outbox = fixture.env.METRIC_EVENT_OUTBOX;
  if (!outbox) throw new Error("fixture outbox is missing");
  let inFlight = 0;
  let peak = 0;
  fixture.env.METRIC_EVENT_OUTBOX = {
    idFromName: (name: string) => outbox.idFromName(name),
    get: (id: DurableObjectId) => {
      const stub = outbox.get(id);
      return {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          if (!String(input).endsWith("/settle-delivery")) return stub.fetch(input, init);
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          try {
            return await stub.fetch(input, init);
          } finally {
            inFlight -= 1;
          }
        },
      };
    },
  } as NonNullable<QueueFixture["env"]["METRIC_EVENT_OUTBOX"]>;
  return () => peak;
}

function failSettleFor(dedupKey: string): void {
  const outbox = fixture.env.METRIC_EVENT_OUTBOX;
  if (!outbox) throw new Error("fixture outbox is missing");
  fixture.env.METRIC_EVENT_OUTBOX = {
    idFromName: (name: string) => outbox.idFromName(name),
    get: (id: DurableObjectId) => {
      const stub = outbox.get(id);
      return {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) =>
          String(id) === dedupKey && String(input).endsWith("/settle-delivery")
            ? new Response("settle unavailable", { status: 503 })
            : stub.fetch(input, init),
      };
    },
  } as NonNullable<QueueFixture["env"]["METRIC_EVENT_OUTBOX"]>;
}

async function ndjsonOf(fetch: TinybirdStub): Promise<Record<string, unknown>[]> {
  const [, init] = firstCall(fetch);
  const compressed = init.body as ReadableStream;
  const text = await new Response(compressed.pipeThrough(new DecompressionStream("gzip"))).text();
  return text.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

function firstCall(fetch: TinybirdStub): [string, RequestInit] {
  const call = fetch.mock.calls[0];
  if (!call) throw new Error("Tinybird was never called");
  return call;
}

function headerOf(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string>)[name];
}
