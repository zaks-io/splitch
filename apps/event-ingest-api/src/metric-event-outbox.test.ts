import { describe, expect, it, vi } from "vitest";
import type { MetricEventDeliveryAttempt } from "./metric-event-delivery-attempt";
import { MetricEventOutboxDurableObject } from "./metric-event-outbox";
import type { Env } from "./types";

const STATE_KEY = "metric-event-claim";
const DEDUP_URL = "https://metric-event-outbox.local/claim";

/**
 * The Durable Object is the only place the accept/duplicate/conflict decision is
 * actually made. Ingest tests assert against a collaborator double, so nothing
 * else in this app can see this class regress.
 */
describe("Metric Event outbox Durable Object", () => {
  it("accepts a first claim and enqueues it once", async () => {
    const outbox = makeOutbox();

    const claim = await outbox.claim(row("entity-7"));

    expect(claim).toEqual({
      outcome: "accepted",
      eventDefinitionId: "ed_signed_up",
      eventDefinitionVersionId: "edv_1",
    });
    expect(outbox.send).toHaveBeenCalledTimes(1);
    expect(outbox.send.mock.calls[0]?.[0]).toEqual(row("entity-7").row);
    expect(outbox.stored()?.queued).toBe(true);
  });

  it("re-enqueues a replay whose first queue send never landed", async () => {
    const outbox = makeOutbox();
    outbox.seed({ ...row("entity-7"), queued: false });

    const claim = await outbox.claim(row("entity-7"));

    expect(claim.outcome).toBe("duplicate");
    expect(outbox.send).toHaveBeenCalledTimes(1);
    expect(outbox.stored()?.queued).toBe(true);
  });

  it("does not enqueue a replay of an event already on the queue", async () => {
    const outbox = makeOutbox();
    outbox.seed({ ...row("entity-7"), queued: true });

    const claim = await outbox.claim(row("entity-7"));

    expect(claim.outcome).toBe("duplicate");
    expect(outbox.send).not.toHaveBeenCalled();
  });

  it("looks up an existing claim without publishing", async () => {
    const outbox = makeOutbox();
    outbox.seed({ ...row("entity-7"), queued: true });

    const lookup = await outbox.lookup();

    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toEqual({
      fingerprint: "fp_entity-7",
      eventDefinitionId: "ed_signed_up",
      eventDefinitionVersionId: "edv_1",
    });
    expect(outbox.send).not.toHaveBeenCalled();
  });

  it("returns 404 when no claim exists yet", async () => {
    const outbox = makeOutbox();

    const lookup = await outbox.lookup();

    expect(lookup.status).toBe(404);
    expect(outbox.send).not.toHaveBeenCalled();
  });

  it("returns the durable delivery attempt used to fence Copy job creation", async () => {
    const outbox = makeOutbox();
    const delivery = {
      attemptId: "attempt-1",
      state: "indeterminate",
      attempts: 1,
      reconciliation: { kind: "copy-starting", claimedAt: "2026-08-30T00:00:00.000Z" },
    } as const satisfies MetricEventDeliveryAttempt;
    outbox.seed({ ...row("entity-7"), queued: true, delivery });

    const response = await outbox.delivery();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(delivery);
  });

  it("rejects a different event reusing the same dedup key", async () => {
    const outbox = makeOutbox();
    const first = { ...row("entity-7"), queued: true };
    outbox.seed(first);

    const claim = await outbox.claim(row("entity-9"));

    expect(claim.outcome).toBe("conflict");
    expect(outbox.send).not.toHaveBeenCalled();
    expect(outbox.stored()).toEqual(first);
  });

  it("redacts the payload and keeps a payload-free claim that suppresses stale retries", async () => {
    const outbox = makeOutbox();
    outbox.seed({ ...row("entity-7"), queued: true });

    const deleted = await outbox.suppress(row("entity-7"));
    const replay = await outbox.claim(row("entity-7"));
    const exported = await outbox.exported();

    expect(deleted).toEqual({ deleted: true, proof: "metric-event-outbox-redacted-v1" });
    expect(replay.outcome).toBe("duplicate");
    expect(exported).toEqual({ deleted: true, row: null });
    expect(outbox.stored()).not.toHaveProperty("row");
    expect(outbox.send).not.toHaveBeenCalled();
  });

  it("does not let a queue send overwrite a concurrent suppression tombstone", async () => {
    let releaseSend!: () => void;
    const sendPaused = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const outbox = makeOutbox(async () => sendPaused);

    const claim = outbox.claim(row("entity-7"));
    await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledTimes(1));
    const suppression = outbox.suppress(row("entity-7"));

    await expect(
      Promise.race([suppression.then(() => "done"), Promise.resolve("blocked")]),
    ).resolves.toBe("blocked");
    releaseSend();
    await expect(claim).resolves.toMatchObject({ outcome: "accepted" });
    await expect(suppression).resolves.toMatchObject({ deleted: true });
    await expect(outbox.exported()).resolves.toEqual({ deleted: true, row: null });
  });
});

interface ClaimInput {
  readonly fingerprint: string;
  readonly eventDefinitionId: string;
  readonly eventDefinitionVersionId: string;
  readonly row: Record<string, unknown>;
}

function row(targetingKey: string): ClaimInput {
  return {
    fingerprint: `fp_${targetingKey}`,
    eventDefinitionId: "ed_signed_up",
    eventDefinitionVersionId: "edv_1",
    row: { event_name: "signed_up", targeting_key_hash: targetingKey },
  };
}

/** Durable Object storage round-trips through structured clone, so this does too. */
function makeOutbox(sendImpl: () => Promise<void> = async () => {}) {
  const storage = new Map<string, unknown>();
  const send = vi.fn(async (_row: Record<string, unknown>) => sendImpl());
  const ctx = {
    storage: {
      async get<T>(key: string) {
        return storage.has(key) ? (structuredClone(storage.get(key)) as T) : undefined;
      },
      async put(key: string, value: unknown) {
        storage.set(key, structuredClone(value));
      },
    },
  } as unknown as DurableObjectState;
  const env = { METRIC_EVENTS_QUEUE: { send } } as unknown as Env;
  const object = new MetricEventOutboxDurableObject(ctx, env);

  return {
    send,
    seed(state: ClaimInput & { queued: boolean; delivery?: MetricEventDeliveryAttempt }) {
      storage.set(STATE_KEY, structuredClone(state));
    },
    stored() {
      return storage.get(STATE_KEY) as (ClaimInput & { queued: boolean }) | undefined;
    },
    async claim(input: ClaimInput) {
      const response = await object.fetch(
        new Request(DEDUP_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...input, queued: false }),
        }),
      );
      expect(response.status).toBe(200);
      return (await response.json()) as { outcome: string };
    },
    lookup() {
      return object.fetch(
        new Request("https://metric-event-outbox.local/lookup", { method: "GET" }),
      );
    },
    delivery() {
      return object.fetch(
        new Request("https://metric-event-outbox.local/delivery", { method: "GET" }),
      );
    },
    async suppress(input: ClaimInput) {
      const response = await object.fetch(
        new Request("https://metric-event-outbox.local/suppress", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
      );
      expect(response.status).toBe(200);
      return response.json();
    },
    async exported() {
      const response = await object.fetch(new Request("https://metric-event-outbox.local/export"));
      expect(response.status).toBe(200);
      return response.json();
    },
  };
}
