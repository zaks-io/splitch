import { describe, expect, it, vi } from "vitest";
import type { MetricEventDeliveryAttempt } from "./metric-event-delivery-attempt";
import { METRIC_EVENT_CLAIM_RETENTION_MS } from "./metric-event-outbox";
import { makeOutbox, row } from "./metric-event-outbox.fixture";

/**
 * The Durable Object is the only place the accept/duplicate/conflict decision is
 * actually made. Ingest tests assert against a collaborator double, so nothing
 * else in this app can see this class regress.
 */
describe("Metric Event outbox Durable Object", () => {
  it("accepts a first claim after scheduling asynchronous publication", async () => {
    const outbox = makeOutbox();

    const claim = await outbox.claim(row("entity-7"));

    expect(claim).toEqual({
      outcome: "accepted",
      eventDefinitionId: "ed_signed_up",
      eventDefinitionVersionId: "edv_1",
    });
    expect(outbox.send).not.toHaveBeenCalled();
    expect(outbox.alarmTime()).toBeTypeOf("number");
    expect(outbox.stored()?.queued).toBe(false);

    await outbox.runAlarm();

    expect(outbox.send).toHaveBeenCalledTimes(1);
    expect(outbox.send.mock.calls[0]?.[0]).toEqual(row("entity-7").row);
    expect(outbox.stored()?.queued).toBe(true);
  });

  it("re-enqueues a replay whose first queue send never landed", async () => {
    const outbox = makeOutbox();
    outbox.seed({ ...row("entity-7"), queued: false });

    const claim = await outbox.claim(row("entity-7"));

    expect(claim.outcome).toBe("duplicate");
    expect(outbox.send).not.toHaveBeenCalled();
    expect(outbox.stored()?.expiresAt).toBeTypeOf("number");
    expect(outbox.alarmTime()).toBeTypeOf("number");
    await outbox.runAlarm();
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
    expect(outbox.stored()).toMatchObject(first);
    expect(outbox.stored()?.expiresAt).toBeTypeOf("number");
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

  it("fails suppression loud while asynchronous queue publication is unresolved", async () => {
    let releaseSend!: () => void;
    const sendPaused = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const outbox = makeOutbox(async () => sendPaused);

    await outbox.claim(row("entity-7"));
    const publication = outbox.runAlarm();
    await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledTimes(1));
    await expect(outbox.suppressResponse(row("entity-7"))).resolves.toMatchObject({ status: 409 });
    releaseSend();
    await publication;
    await expect(outbox.suppress(row("entity-7"))).resolves.toMatchObject({ deleted: true });
    await expect(outbox.exported()).resolves.toEqual({ deleted: true, row: null });
  });
});

describe("Metric Event outbox retention", () => {
  it("deletes claim state when the Metric Event retention window ends", async () => {
    const now = Date.parse("2026-08-31T00:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const outbox = makeOutbox();

    await outbox.claim(row("entity-7"));
    await outbox.runAlarm();

    const expiresAt = Date.parse("2026-08-07T00:00:00.000Z") + METRIC_EVENT_CLAIM_RETENTION_MS;
    expect(outbox.alarmTime()).toBe(expiresAt);
    vi.spyOn(Date, "now").mockReturnValue(expiresAt);
    await outbox.runAlarm();
    expect(outbox.stored()).toBeUndefined();
  });

  it("anchors a pre-upgrade claim to its original receipt time", async () => {
    const receivedAt = Date.parse("2026-08-07T00:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(receivedAt + 24 * 60 * 60 * 1_000);
    const outbox = makeOutbox();
    outbox.seed({ ...row("entity-7"), queued: true });

    const retained = await outbox.retain("2026-08-07T00:00:00.000Z");

    expect(retained).toEqual({
      retained: true,
      expiresAt: receivedAt + METRIC_EVENT_CLAIM_RETENTION_MS,
    });
    expect(outbox.alarmTime()).toBe(receivedAt + METRIC_EVENT_CLAIM_RETENTION_MS);
  });

  it("adopts retention when a legacy queued row reaches delivery after the backfill scan", async () => {
    const receivedAt = Date.parse("2026-08-07T00:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(receivedAt + 24 * 60 * 60 * 1_000);
    const outbox = makeOutbox();
    outbox.seed({ ...row("entity-7"), queued: true });

    await outbox.beginDelivery("attempt-1");

    expect(outbox.stored()?.expiresAt).toBe(receivedAt + METRIC_EVENT_CLAIM_RETENTION_MS);
    expect(outbox.alarmTime()).toBe(receivedAt + METRIC_EVENT_CLAIM_RETENTION_MS);
    expect(outbox.stored()?.delivery).toMatchObject({ state: "attempting" });
  });

  it("removes an already expired pre-upgrade claim during adoption", async () => {
    const receivedAt = Date.parse("2026-05-01T00:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(receivedAt + METRIC_EVENT_CLAIM_RETENTION_MS);
    const outbox = makeOutbox();
    outbox.seed({ ...row("entity-7", "2026-05-01T00:00:00.000Z"), queued: true });

    await expect(outbox.retain("2026-05-01T00:00:00.000Z")).resolves.toEqual({
      retained: false,
      expired: true,
    });
    expect(outbox.stored()).toBeUndefined();
  });
});
