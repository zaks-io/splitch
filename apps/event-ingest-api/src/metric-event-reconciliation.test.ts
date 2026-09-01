import { afterEach, describe, expect, it, vi } from "vitest";
import type { MetricEventDeliveryAttempt } from "./metric-event-delivery-attempt";
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
    const queued = message(2);

    await handleMetricEventReconciliationQueue(batch(queued), env(outbox));

    expect(queued.ack).not.toHaveBeenCalled();
    expect(queued.retry).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
    const populateUrl = new URL(String(fetch.mock.calls[1]?.[0]));
    expect(populateUrl.pathname).toBe("/v0/pipes/populate_metric_event_delivery_state/copy");
    expect(fetch.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ method: "POST" }));
    expect(outbox.delivery().reconciliation).toEqual({
      kind: "copy-job",
      jobId: "copy-job-1",
    });
  });

  it("polls the same Copy job before verifying and settling aggregate state", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ data: [{ raw_rows: 1, state_rows: 0 }] }))
      .mockResolvedValueOnce(Response.json({ status: "done" }))
      .mockResolvedValueOnce(Response.json({ data: [{ raw_rows: 1, state_rows: 1 }] }));
    vi.stubGlobal("fetch", fetch);
    const outbox = outboxNamespace({
      kind: "copy-job",
      jobId: "copy-job-1",
    });
    const reconciliationQueue = queue();
    const queued = message(3);

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
    const outbox = outboxNamespace({
      kind: "copy-job",
      jobId: "copy-job-1",
    });
    const reconciliationQueue = queue();
    const queued = message(3);

    await handleMetricEventReconciliationQueue(batch(queued), env(outbox, reconciliationQueue));

    expect(queued.ack).not.toHaveBeenCalled();
    expect(queued.retry).toHaveBeenCalledOnce();
    expect(reconciliationQueue.send).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(outbox.delivery().reconciliation).toEqual({
      kind: "copy-job",
      jobId: "copy-job-1",
    });
  });

  it("never starts a second Copy job after the first start loses its response", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ data: [{ raw_rows: 1, state_rows: 0 }] }))
      .mockRejectedValueOnce(new Error("Copy response lost"))
      .mockResolvedValueOnce(Response.json({ data: [{ raw_rows: 1, state_rows: 0 }] }));
    vi.stubGlobal("fetch", fetch);
    const outbox = outboxNamespace();
    const queued = message(2);

    await handleMetricEventReconciliationQueue(batch(queued), env(outbox));
    await handleMetricEventReconciliationQueue(batch(queued), env(outbox));

    expect(queued.retry).toHaveBeenCalledTimes(2);
    expect(queued.ack).not.toHaveBeenCalled();
    expect(outbox.delivery().reconciliation?.kind).toBe("copy-starting");
    expect(fetch.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
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

describe("Metric Event reconciliation batch ordering", () => {
  it("serializes duplicate messages before starting a Copy job", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ data: [{ raw_rows: 1, state_rows: 0 }] }))
      .mockResolvedValueOnce(
        Response.json({ job: { job_id: "copy-job-1", status: "waiting" } }, { status: 202 }),
      )
      .mockResolvedValueOnce(Response.json({ data: [{ raw_rows: 1, state_rows: 0 }] }))
      .mockResolvedValueOnce(Response.json({ status: "working" }));
    vi.stubGlobal("fetch", fetch);
    const outbox = outboxNamespace();
    const first = message(2, "reconcile-1");
    const duplicate = message(2, "reconcile-2");

    await handleMetricEventReconciliationQueue(batch(first, duplicate), env(outbox));

    expect(first.retry).toHaveBeenCalledOnce();
    expect(duplicate.retry).toHaveBeenCalledOnce();
    expect(fetch.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
    expect(outbox.delivery().reconciliation).toEqual({
      kind: "copy-job",
      jobId: "copy-job-1",
    });
  });
});

function message(attempts: number, id = "reconcile-1") {
  return {
    id,
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

function batch(...messages: ReturnType<typeof message>[]) {
  return {
    queue: "splitch-metric-events-reconciliation",
    messages,
    metadata: { metrics: { backlogCount: messages.length, backlogBytes: 1_024 } },
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } satisfies MessageBatch<Record<string, unknown>>;
}

function outboxNamespace(reconciliation?: MetricEventDeliveryAttempt["reconciliation"]) {
  let delivery: MetricEventDeliveryAttempt = {
    attemptId: "attempt-1",
    state: "indeterminate",
    attempts: 1,
    ...(reconciliation === undefined ? {} : { reconciliation }),
  };
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === "/delivery") return Response.json(delivery);
    if (path === "/settle-delivery") {
      delivery = JSON.parse(String(init?.body)) as typeof delivery;
      return Response.json({ settled: delivery.state });
    }
    return Response.json({ ok: true });
  });
  return {
    fetch,
    delivery: () => delivery,
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
