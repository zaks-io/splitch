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
  it("removes delivery-scoped state when its retention alarm fires", async () => {
    const append = vi.fn(async () => Response.json({ successful_rows: 1, quarantined_rows: 0 }));
    vi.stubGlobal("fetch", append);
    const privacy = rawEventPrivacyNamespace();
    const queued = rawEventMessage("retained-state");
    const overrides = {
      SPLITCH_PLATFORM_TARGET: "production" as const,
      ENTITY_METRIC_PRIVACY: privacy.namespace,
    };

    await deliverRawEventMessages("splitch-raw-events", [queued], overrides);
    await privacy.alarm("app_1:raw-delivery-state:queue:raw_events:retained-state");
    await deliverRawEventMessages("splitch-raw-events", [queued], overrides);

    expect(append).toHaveBeenCalledTimes(2);
  });

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

  it("releases the App permit when the nested Entity completion response is lost", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 422 })),
    );
    const privacy = rawEventPrivacyNamespace("/complete-row");
    const queued = rawEventMessage("lost-nested-completion");

    await deliverRawEventMessages("splitch-raw-events", [queued], {
      SPLITCH_PLATFORM_TARGET: "production",
      ENTITY_METRIC_PRIVACY: privacy.namespace,
    });

    expect(queued.retry).toHaveBeenCalledOnce();
    const reset = await privacy.fetch("app_1:app-identity-inventory", "/reset-app", {
      appId: "app_1",
      resetId: "reset_after_nested_completion",
      currentVersion: "app-v1",
    });
    expect(reset.status).toBe(200);
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
