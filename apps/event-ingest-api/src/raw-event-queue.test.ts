import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deliverRawEventMessages as deliver,
  rawEventMessage as message,
  rawEventPrivacyNamespace as privacyNamespace,
} from "./raw-event-queue-test-fixture";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("raw event queue delivery", () => {
  it("microbatches rows with a confirmed Tinybird commit", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ successful_rows: 100, quarantined_rows: 0 }),
    );
    vi.stubGlobal("fetch", fetch);
    const messages = Array.from({ length: 100 }, (_, index) => message(String(index)));

    await deliver("splitch-raw-events", messages);

    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]?.[0])).toContain("name=raw_events&wait=true");
    for (const queued of messages) expect(queued.ack).toHaveBeenCalledOnce();
  });

  it("durably transfers an indeterminate commit without resubmitting it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 422 })),
    );
    const queued = message("one");

    const { rawEventsDlq } = await deliver("splitch-raw-events", [queued]);

    expect(rawEventsDlq.sendBatch).toHaveBeenCalledOnce();
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
    const calls = rawEventsDlq.sendBatch.mock.calls as unknown as Array<
      [Array<{ body: Record<string, unknown> }>]
    >;
    expect(calls[0]?.[0]?.[0]?.body).toEqual(
      expect.objectContaining({
        kind: "raw-event-delivery-failure-v1",
        classification: "indeterminate",
      }),
    );
  });

  it("durably transfers a no-response outcome without resubmitting it", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("connection reset");
    });
    vi.stubGlobal("fetch", fetch);
    const queued = message("one");

    const { rawEventsDlq } = await deliver("splitch-raw-events", [queued]);

    expect(fetch).toHaveBeenCalledOnce();
    expect(rawEventsDlq.sendBatch).toHaveBeenCalledOnce();
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
  });

  it("transfers a permanent failure to the datasource DLQ after one Tinybird request", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 400 }));
    vi.stubGlobal("fetch", fetch);
    const queued = message("one");

    const { rawEventsDlq } = await deliver("splitch-raw-events", [queued]);

    expect(fetch).toHaveBeenCalledOnce();
    expect(rawEventsDlq.sendBatch).toHaveBeenCalledOnce();
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
  });

  it("keeps transient failures on the primary queue", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    const queued = message("one");

    const { rawEventsDlq } = await deliver("splitch-raw-events", [queued]);

    expect(rawEventsDlq.sendBatch).not.toHaveBeenCalled();
    expect(queued.ack).not.toHaveBeenCalled();
    expect(queued.retry).toHaveBeenCalledOnce();
  });

  it("emits payload-free backlog and outcome telemetry", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ successful_rows: 1, quarantined_rows: 0 })),
    );
    const queued = message("telemetry", "raw_evaluations");

    await deliver("splitch-raw-evaluations", [queued]);

    const settlement = info.mock.calls.find(
      ([message]) => message === "event-ingest-api raw event batch settled",
    );
    expect(settlement?.[1]).toEqual(
      expect.objectContaining({
        queue: "splitch-raw-evaluations",
        datasource: "raw_evaluations",
        rowCount: 1,
        deliveredCount: 1,
        retryableCount: 0,
        indeterminateCount: 0,
        poisonCount: 0,
        suppressedCount: 0,
        backlogCount: 1,
        backlogBytes: 1_024,
        oldestMessageTimestamp: "2026-08-30T00:00:00.000Z",
      }),
    );
    expect(JSON.stringify(settlement?.[1])).not.toContain("app_id");
    expect(JSON.stringify(settlement?.[1])).not.toContain("sha256:telemetry");
  });

  it("rejects a datasource envelope on the wrong queue", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const queued = message("one", "raw_evaluations");

    await deliver("splitch-raw-events", [queued]);

    expect(fetch).not.toHaveBeenCalled();
    expect(queued.retry).toHaveBeenCalledOnce();
  });

  it("uses queue identity even when an envelope kind is malformed", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const queued = message("one");
    queued.body.kind = "corrupt";

    await deliver("splitch-raw-events", [queued]);

    expect(fetch).not.toHaveBeenCalled();
    expect(queued.retry).toHaveBeenCalledOnce();
  });
});

describe("raw event queue privacy permits", () => {
  it.each([
    ["Exposure", "splitch-raw-events", "raw_events"],
    ["Evaluation", "splitch-raw-evaluations", "raw_evaluations"],
  ])("blocks an App reset until an admitted %s queue append completes", async (_, queue, source) => {
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const append = vi.fn(async () => {
      await appendGate;
      return Response.json({ successful_rows: 1, quarantined_rows: 0 });
    });
    vi.stubGlobal("fetch", append);
    const privacy = privacyNamespace();
    const queued = message("permit-race", source);
    const delivery = deliver(queue, [queued], {
      SPLITCH_PLATFORM_TARGET: "production",
      ENTITY_METRIC_PRIVACY: privacy.namespace,
    });
    await vi.waitFor(() => expect(append).toHaveBeenCalledOnce());

    const resetWhilePending = await privacy.fetch("app_1:app-identity-inventory", "/reset-app", {
      appId: "app_1",
      resetId: "reset_queue_race",
      currentVersion: "app-v1",
    });
    expect(resetWhilePending.status).toBe(409);
    expect(queued.ack).not.toHaveBeenCalled();

    releaseAppend();
    await delivery;
    expect(queued.ack).toHaveBeenCalledOnce();
    const resetAfterDelivery = await privacy.fetch("app_1:app-identity-inventory", "/reset-app", {
      appId: "app_1",
      resetId: "reset_queue_race",
      currentVersion: "app-v1",
    });
    expect(resetAfterDelivery.status).toBe(200);
  });

  it.each([
    ["Exposure", "splitch-raw-events", "raw_events", "/admit-entity-row"],
    ["Evaluation", "splitch-raw-evaluations", "raw_evaluations", "/admit-app-row"],
  ])("clears stale %s permits after every lost admission response", async (_, queue, source, lostPath) => {
    const append = vi.fn();
    vi.stubGlobal("fetch", append);
    const privacy = privacyNamespace(lostPath, 8);
    const queued = message("lost-admission", source);
    const overrides = {
      SPLITCH_PLATFORM_TARGET: "production" as const,
      ENTITY_METRIC_PRIVACY: privacy.namespace,
    };

    for (let attempt = 1; attempt <= 8; attempt += 1) {
      queued.attempts = attempt;
      await deliver(queue, [queued], overrides);
    }
    expect(queued.retry).toHaveBeenCalledTimes(8);
    expect(append).not.toHaveBeenCalled();
    const reset = await privacy.fetch("app_1:app-identity-inventory", "/reset-app", {
      appId: "app_1",
      resetId: "reset_lost_admission",
      currentVersion: "app-v1",
    });
    expect(reset.status).toBe(200);
  });

  it("rolls back the App and Entity permits when nested admission fails", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const privacy = privacyNamespace("/admit-row");
    const queued = message("nested-admission-failure");

    await deliver("splitch-raw-events", [queued], {
      SPLITCH_PLATFORM_TARGET: "production",
      ENTITY_METRIC_PRIVACY: privacy.namespace,
    });

    expect(queued.retry).toHaveBeenCalledOnce();
    const reset = await privacy.fetch("app_1:app-identity-inventory", "/reset-app", {
      appId: "app_1",
      resetId: "reset_nested_failure",
      currentVersion: "app-v1",
    });
    expect(reset.status).toBe(200);
  });
});
