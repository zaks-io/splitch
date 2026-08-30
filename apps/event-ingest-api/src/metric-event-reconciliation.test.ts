import { afterEach, describe, expect, it, vi } from "vitest";
import { handleMetricEventReconciliationQueue } from "./metric-event-reconciliation";
import type { Env } from "./types";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Metric Event reconciliation", () => {
  it("settles a raw commit as delivered", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ data: [{ raw_rows: 1, state_rows: 1 }] }),
    );
    vi.stubGlobal("fetch", fetch);
    const outbox = outboxNamespace();
    const queued = message(2);

    await handleMetricEventReconciliationQueue(batch(queued), env(outbox));

    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
    const requested = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(requested.searchParams.get("server_received_at")).toBe("2026-08-30 00:00:00.000");
    expect(outbox.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/settle-delivery"),
      expect.objectContaining({ body: expect.stringContaining('"state":"delivered"') }),
    );
  });

  it("populates raw-only aggregate state and verifies it before settlement", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ data: [{ raw_rows: 1, state_rows: 0 }] }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ data: [{ raw_rows: 1, state_rows: 1 }] }));
    vi.stubGlobal("fetch", fetch);
    const outbox = outboxNamespace();
    const queued = message(2);

    await handleMetricEventReconciliationQueue(batch(queued), env(outbox));

    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(3);
    const populateUrl = new URL(String(fetch.mock.calls[1]?.[0]));
    expect(populateUrl.pathname).toBe("/v0/pipes/populate_metric_event_delivery_state/copy");
    expect(fetch.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ method: "POST" }));
    expect(fetch.mock.calls[2]?.[0]).toEqual(fetch.mock.calls[0]?.[0]);
  });

  it("keeps a scoped absence unresolved for DLQ and operator review", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: [{ raw_rows: 0, state_rows: 0 }] })),
    );
    const outbox = outboxNamespace();
    const queued = message(8);

    await handleMetricEventReconciliationQueue(batch(queued), env(outbox));

    expect(queued.ack).not.toHaveBeenCalled();
    expect(queued.retry).toHaveBeenCalledOnce();
    expect(outbox.fetch).not.toHaveBeenCalled();
  });
});

function message(attempts: number) {
  return {
    id: "reconcile-1",
    timestamp: new Date("2026-08-30T00:00:00.000Z"),
    attempts,
    body: {
      kind: "metric-event-reconciliation-v1",
      dedupKey: "sha256:event-1",
      attempt: { attemptId: "attempt-1", state: "indeterminate", attempts: 1 },
      appId: "app_1",
      environmentId: "env_1",
      eventDefinitionId: "event_definition_1",
      serverReceivedAt: "2026-08-30T00:00:00.000Z",
    },
    ack: vi.fn(),
    retry: vi.fn(),
  } satisfies Message<Record<string, unknown>>;
}

function batch(queued: ReturnType<typeof message>) {
  return {
    queue: "splitch-metric-events-reconciliation",
    messages: [queued],
    metadata: { metrics: { backlogCount: 1, backlogBytes: 1_024 } },
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } satisfies MessageBatch<Record<string, unknown>>;
}

function outboxNamespace() {
  const fetch = vi.fn(async () => Response.json({ ok: true }));
  return {
    fetch,
    namespace: {
      idFromName: (name: string) => name as unknown as DurableObjectId,
      get: () => ({ fetch }),
    },
  };
}

function env(outbox: ReturnType<typeof outboxNamespace>): Env {
  return {
    SPLITCH_PLATFORM_TARGET: "local",
    TINYBIRD_API_URL: "https://tinybird.test",
    TINYBIRD_READ_TOKEN: "read-token",
    TINYBIRD_COPY_TOKEN: "copy-token",
    METRIC_EVENT_OUTBOX: outbox.namespace,
  };
}
