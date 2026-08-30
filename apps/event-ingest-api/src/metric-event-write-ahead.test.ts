/**
 * The write-ahead delivery-attempt record: what a claim means to a redelivery,
 * what it means to a concurrent privacy deletion, and how a row's attempts add
 * up to a dead-letter transfer.
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
  suppress,
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

describe("Metric Event write-ahead delivery attempts", () => {
  /**
   * An invocation that dies between the claim and a confirmed outcome leaves
   * `attempting` behind. That state is only ambiguous to a *concurrent*
   * deletion; to a later invocation it means nothing ever confirmed a dispatch,
   * so the row is re-sent. Acknowledging it instead drops the event with no
   * record anywhere that it ever existed.
   */
  it("re-sends a claim left behind by an invocation that died mid-delivery", async () => {
    stubTinybird(commit(2));
    failEverySettle();
    const stranded = await seal(fixture, ["event-1", "event-2"]);
    await deliver(fixture.env, stranded);
    expect(stranded[0]?.retry).toHaveBeenCalledOnce();
    expect(fixture.deliveryState("sha256:event-1")).toBe("attempting");

    restoreSettle();
    const fetch = stubTinybird(commit(1));
    const redelivered = queueMessage("event-1", 3);
    await deliver(fixture.env, [redelivered]);

    expect(fetch, "the stranded row is never sent again").toHaveBeenCalledOnce();
    expect(redelivered.ack).toHaveBeenCalledOnce();
    expect(fixture.deliveryState("sha256:event-1")).toBe("delivered");
  });

  /**
   * The other half of what `attempting` means. A redelivery may re-send it, but
   * a deletion arriving while the claiming invocation is still alive must not:
   * that row may be mid-flight, and the proof would cover a row that lands.
   */
  it("refuses to redact an event whose delivery is still in flight", async () => {
    stubTinybird(commit(1));
    failEverySettle();
    await deliver(fixture.env, await seal(fixture, ["event-1"]));
    expect(fixture.deliveryState("sha256:event-1")).toBe("attempting");
    restoreSettle();

    await expect(suppress(fixture.env, metricEvent("event-1"))).resolves.toMatchObject({
      status: 409,
    });
  });

  /** A claim the consumer cannot possibly send would spend the row's budget for nothing. */
  it("claims no write-ahead record when the Tinybird configuration is unavailable", async () => {
    (fixture.env as { TINYBIRD_INGEST_TOKEN?: string }).TINYBIRD_INGEST_TOKEN = undefined;
    const message = await sealOne(fixture, "event-1");

    await deliver(fixture.env, [message]);

    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
    expect(fixture.deliveryState("sha256:event-1")).toBeUndefined();
  });

  /**
   * Two things have to hold together on the last delivery. The attempt count
   * lives on the durable record, so every redelivery carries that record's own
   * count back rather than reporting a fresh first attempt. And the transfer
   * happens on attempt eight, the last one `max_retries = 7` yields: waiting for
   * a ninth would hand the message to Cloudflare's own dead-letter queue with
   * none of this envelope's failure metadata and the record stuck `retryable`.
   */
  it("dead-letters itself on the final delivery Cloudflare will ever make", async () => {
    stubTinybird(undefined);
    await fixture.seal(metricEvent("event-1"));
    for (let attempt = 1; attempt <= 7; attempt += 1) {
      await deliver(fixture.env, [queueMessage("event-1", attempt)]);
    }
    expect(fixture.dlq.sendBatch).not.toHaveBeenCalled();

    const final = queueMessage("event-1", 8);
    await deliver(fixture.env, [final]);

    expect(final.ack).toHaveBeenCalledOnce();
    expect(
      final.retry,
      "a retry here is a request Cloudflare will never honor",
    ).not.toHaveBeenCalled();
    expect(fixture.deliveryState("sha256:event-1")).toBe("poison_transferred");
    const [[[envelope]]] = fixture.dlq.sendBatch.mock.calls as [[[{ body: DeadLetter }]]];
    expect(envelope.body.failure.attempts).toBe(8);
  });

  /**
   * A 422 leaves the record `indeterminate`: retrying can duplicate committed
   * rows and discarding can lose uncommitted ones, so only reconciliation may
   * resolve it and no redelivery ever resubmits.
   */
  it("never resubmits a row whose write-ahead attempt is unresolved", async () => {
    stubTinybird(undefined, { status: 422 });
    await deliver(fixture.env, await seal(fixture, ["event-1"]));

    const fetch = stubTinybird(commit(1));
    const redelivered = queueMessage("event-1", 3);
    await deliver(fixture.env, [redelivered]);

    expect(fetch).not.toHaveBeenCalled();
    expect(redelivered.ack).toHaveBeenCalledOnce();
  });

  /**
   * The append moved out of the Entity Durable Object, so the outbox record is
   * what keeps a deletion proof from being returned over a row already in
   * flight. An unresolved attempt refuses redaction; the deletion job retries.
   */
  it("refuses to redact an event whose delivery attempt is unresolved", async () => {
    stubTinybird(undefined, { status: 422 });
    await deliver(fixture.env, await seal(fixture, ["event-1"]));

    await expect(suppress(fixture.env, metricEvent("event-1"))).resolves.toMatchObject({
      status: 409,
    });
  });

  it("redacts an event once its delivery attempt has settled", async () => {
    stubTinybird(commit(1));
    await deliver(fixture.env, await seal(fixture, ["event-1"]));

    await expect(suppress(fixture.env, metricEvent("event-1"))).resolves.toMatchObject({
      status: 200,
    });
  });
});

interface DeadLetter {
  readonly failure: { readonly attempts: number };
}

type Outbox = NonNullable<QueueFixture["env"]["METRIC_EVENT_OUTBOX"]>;
let intactOutbox: Outbox | undefined;

/** Models the round trip that dies after the request went out and before it settled. */
function failEverySettle(): void {
  const outbox = fixture.env.METRIC_EVENT_OUTBOX;
  if (!outbox) throw new Error("fixture outbox is missing");
  intactOutbox = outbox;
  fixture.env.METRIC_EVENT_OUTBOX = {
    idFromName: (name: string) => outbox.idFromName(name),
    get: (id: DurableObjectId) => {
      const stub = outbox.get(id);
      return {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) =>
          String(input).endsWith("/settle-delivery")
            ? new Response("settle unavailable", { status: 503 })
            : stub.fetch(input, init),
      };
    },
  } as Outbox;
}

function restoreSettle(): void {
  fixture.env.METRIC_EVENT_OUTBOX = intactOutbox;
}
