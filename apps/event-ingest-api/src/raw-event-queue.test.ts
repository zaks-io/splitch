import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import type { Env } from "./types";

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

function message(id: string, datasource = "raw_events") {
  return {
    id,
    timestamp: new Date("2026-08-30T00:00:00.000Z"),
    attempts: 1,
    body: {
      kind: "raw-event-delivery-v1",
      datasource,
      row: {
        app_id: "app_1",
        environment_id: "env_1",
        id_type: "user",
        targeting_key_hash: "app-v1:target",
        entity_family_hash: "app-v1:family",
        server_received_at: "2026-08-30T00:00:00.000Z",
        dedup_key: `sha256:${id}`,
      },
    },
    ack: vi.fn(),
    retry: vi.fn(),
  } satisfies Message<Record<string, unknown>>;
}

async function deliver(queue: string, messages: readonly ReturnType<typeof message>[]) {
  if (!worker.queue) throw new Error("queue handler is unavailable");
  const rawEventsDlq = { send: vi.fn(), sendBatch: vi.fn(), metrics: vi.fn() };
  const rawEvaluationsDlq = { send: vi.fn(), sendBatch: vi.fn(), metrics: vi.fn() };
  await worker.queue(
    {
      queue,
      messages,
      metadata: { metrics: { backlogCount: messages.length, backlogBytes: 1_024 } },
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    },
    {
      SPLITCH_PLATFORM_TARGET: "local",
      TINYBIRD_API_URL: "https://tinybird.test",
      TINYBIRD_INGEST_TOKEN: "test-token",
      RAW_EVENTS_DLQ: rawEventsDlq,
      RAW_EVALUATIONS_DLQ: rawEvaluationsDlq,
    } as Env,
    {} as ExecutionContext,
  );
  return { rawEventsDlq, rawEvaluationsDlq };
}
