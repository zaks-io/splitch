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

  it("durably hands off an asynchronous Copy job before acknowledging", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ data: [{ raw_rows: 1, state_rows: 0 }] }))
      .mockResolvedValueOnce(
        Response.json({ job: { job_id: "copy-job-1", status: "waiting" } }, { status: 202 }),
      );
    vi.stubGlobal("fetch", fetch);
    const outbox = outboxNamespace();
    const reconciliationQueue = queue();
    const queued = message(2);

    await handleMetricEventReconciliationQueue(batch(queued), env(outbox, reconciliationQueue));

    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
    expect(outbox.fetch).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);
    const populateUrl = new URL(String(fetch.mock.calls[1]?.[0]));
    expect(populateUrl.pathname).toBe("/v0/pipes/populate_metric_event_delivery_state/copy");
    expect(fetch.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ method: "POST" }));
    expect(reconciliationQueue.send).toHaveBeenCalledWith(
      expect.objectContaining({ copyJobId: "copy-job-1" }),
    );
  });

  it("polls the same Copy job before verifying and settling aggregate state", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ data: [{ raw_rows: 1, state_rows: 0 }] }))
      .mockResolvedValueOnce(Response.json({ status: "done" }))
      .mockResolvedValueOnce(Response.json({ data: [{ raw_rows: 1, state_rows: 1 }] }));
    vi.stubGlobal("fetch", fetch);
    const outbox = outboxNamespace();
    const reconciliationQueue = queue();
    const queued = message(3, "copy-job-1");

    await handleMetricEventReconciliationQueue(batch(queued), env(outbox, reconciliationQueue));

    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
    expect(reconciliationQueue.send).not.toHaveBeenCalled();
    const jobUrl = new URL(String(fetch.mock.calls[1]?.[0]));
    expect(jobUrl.pathname).toBe("/v0/jobs/copy-job-1");
    expect(fetch.mock.calls[2]?.[0]).toEqual(fetch.mock.calls[0]?.[0]);
    expect(outbox.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/settle-delivery"),
      expect.objectContaining({ body: expect.stringContaining('"state":"delivered"') }),
    );
  });

  it("retries a pending Copy job without starting another job", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ data: [{ raw_rows: 1, state_rows: 0 }] }))
      .mockResolvedValueOnce(Response.json({ status: "working" }));
    vi.stubGlobal("fetch", fetch);
    const outbox = outboxNamespace();
    const reconciliationQueue = queue();
    const queued = message(3, "copy-job-1");

    await handleMetricEventReconciliationQueue(batch(queued), env(outbox, reconciliationQueue));

    expect(queued.ack).not.toHaveBeenCalled();
    expect(queued.retry).toHaveBeenCalledOnce();
    expect(reconciliationQueue.send).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(outbox.fetch).not.toHaveBeenCalled();
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

function message(attempts: number, copyJobId?: string) {
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
      ...(copyJobId === undefined ? {} : { copyJobId }),
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

function queue() {
  const metrics = { backlogCount: 0, backlogBytes: 0 };
  return {
    send: vi.fn(async () => ({ metadata: { metrics } })),
    sendBatch: vi.fn(async () => ({ metadata: { metrics } })),
    metrics: vi.fn(async () => metrics),
  };
}

function env(outbox: ReturnType<typeof outboxNamespace>, reconciliationQueue = queue()): Env {
  return {
    SPLITCH_PLATFORM_TARGET: "local",
    TINYBIRD_API_URL: "https://tinybird.test",
    TINYBIRD_READ_TOKEN: "read-token",
    TINYBIRD_COPY_TOKEN: "copy-token",
    METRIC_EVENT_OUTBOX: outbox.namespace,
    METRIC_EVENTS_RECONCILIATION_QUEUE: reconciliationQueue,
  };
}
