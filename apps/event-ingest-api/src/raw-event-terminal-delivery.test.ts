import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deliverRawEventMessages,
  rawEventMessage,
  rawEventPrivacyNamespace,
} from "./raw-event-queue-test-fixture";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("raw event terminal delivery recovery", () => {
  it("does not resubmit a Tinybird attempt when privacy completion is lost", async () => {
    const append = vi.fn(async () => new Response(null, { status: 422 }));
    vi.stubGlobal("fetch", append);
    const privacy = rawEventPrivacyNamespace("/complete-entity-row");
    const rawEventsDlq = { send: vi.fn(), sendBatch: vi.fn(), metrics: vi.fn() };
    const queued = rawEventMessage("lost-terminal-completion");
    const overrides = {
      SPLITCH_PLATFORM_TARGET: "production" as const,
      ENTITY_METRIC_PRIVACY: privacy.namespace,
      RAW_EVENTS_DLQ: rawEventsDlq,
    };

    await deliverRawEventMessages("splitch-raw-events", [queued], overrides);
    expect(queued.retry).toHaveBeenCalledOnce();
    expect(queued.ack).not.toHaveBeenCalled();

    queued.attempts = 2;
    await deliverRawEventMessages("splitch-raw-events", [queued], overrides);

    expect(append).toHaveBeenCalledOnce();
    expect(rawEventsDlq.sendBatch).toHaveBeenCalledOnce();
    expect(rawEventsDlq.send).not.toHaveBeenCalled();
    expect(queued.ack).toHaveBeenCalledOnce();
  });

  it("resumes a lost DLQ transfer without resubmitting the Tinybird attempt", async () => {
    const append = vi.fn(async () => new Response(null, { status: 422 }));
    vi.stubGlobal("fetch", append);
    const privacy = rawEventPrivacyNamespace();
    const rawEventsDlq = {
      send: vi.fn(),
      sendBatch: vi.fn().mockRejectedValueOnce(new Error("DLQ response lost")),
      metrics: vi.fn(),
    };
    const queued = rawEventMessage("lost-dlq-transfer");
    const overrides = {
      SPLITCH_PLATFORM_TARGET: "production" as const,
      ENTITY_METRIC_PRIVACY: privacy.namespace,
      RAW_EVENTS_DLQ: rawEventsDlq,
    };

    await deliverRawEventMessages("splitch-raw-events", [queued], overrides);
    expect(queued.retry).toHaveBeenCalledOnce();

    queued.attempts = 2;
    await deliverRawEventMessages("splitch-raw-events", [queued], overrides);

    expect(append).toHaveBeenCalledOnce();
    expect(rawEventsDlq.sendBatch).toHaveBeenCalledOnce();
    expect(rawEventsDlq.send).toHaveBeenCalledOnce();
    expect(queued.ack).toHaveBeenCalledOnce();
  });
});
