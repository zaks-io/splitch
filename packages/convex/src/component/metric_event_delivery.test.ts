import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import {
  deliverMetricEventHandler,
  finishMetricEventDeliveryHandler,
  watchMetricEventDeliveryHandler,
} from "./metric_event_delivery";

const EVENT_ID = "018f7a42-8c11-7c5a-9d4e-123456789abc";
const NOW = 1_800_000_000_000;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Metric Event delivery", () => {
  it("records acceptance before deleting the raw outbox row", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { ctx, patch, deleteRow } = finishContext();

    await finishMetricEventDeliveryHandler(ctx, {
      eventId: EVENT_ID,
      outcome: "accepted",
      leaseExpiresAt: NOW + 60_000,
    });

    expect(patch).toHaveBeenCalledWith("claim", {
      state: "accepted",
      completedAt: NOW,
      lastError: undefined,
    });
    expect(deleteRow).toHaveBeenCalledWith("outbox");
  });

  it("scrubs terminal delivery and logs its safe error", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { ctx, patch, deleteRow } = finishContext();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await finishMetricEventDeliveryHandler(ctx, {
      eventId: EVENT_ID,
      outcome: "terminal",
      leaseExpiresAt: NOW + 60_000,
      error: "HTTP 400 EVENT_SCHEMA_MISMATCH: Metric Event is invalid",
    });

    expect(patch).toHaveBeenCalledWith("claim", {
      state: "terminal",
      completedAt: NOW,
      lastError: "HTTP 400 EVENT_SCHEMA_MISMATCH: Metric Event is invalid",
    });
    expect(deleteRow).toHaveBeenCalledWith("outbox");
    expect(error).toHaveBeenCalledWith("Splitch Metric Event delivery stopped", {
      eventId: EVENT_ID,
      error: "HTTP 400 EVENT_SCHEMA_MISMATCH: Metric Event is invalid",
    });
  });

  it("makes a deterministic schema rejection terminal and observable", async () => {
    const { ctx, runMutation } = actionContext();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { code: "EVENT_SCHEMA_MISMATCH", message: "Metric Event is invalid", details: {} },
            { status: 400 },
          ),
        ),
    );
    await deliverMetricEventHandler(ctx, { eventId: EVENT_ID });

    expect(runMutation.mock.calls[1]?.[1]).toEqual({
      eventId: EVENT_ID,
      outcome: "terminal",
      leaseExpiresAt: NOW + 60_000,
      error: "HTTP 400 EVENT_SCHEMA_MISMATCH: Metric Event is invalid",
    });
  });

  it("retries a malformed success with the same eventId", async () => {
    const { ctx, runMutation } = actionContext();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ accepted: true }, { status: 202 })),
    );

    await deliverMetricEventHandler(ctx, { eventId: EVENT_ID });

    expect(runMutation.mock.calls[1]?.[1]).toEqual({
      eventId: EVENT_ID,
      outcome: "retry",
      leaseExpiresAt: NOW + 60_000,
      error: "Metric Event response did not match the track contract",
    });
  });

  it("restarts an expired delivery lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const runAfter = vi.fn().mockResolvedValue("scheduled");
    const unique = vi.fn().mockResolvedValue({
      eventId: EVENT_ID,
      createdAt: NOW - 1_000,
      state: "delivering",
      nextAttemptAt: NOW,
    });
    const ctx = {
      db: { query: vi.fn(() => ({ withIndex: vi.fn(() => ({ unique })) })) },
      scheduler: { runAfter },
    } as unknown as MutationCtx;

    await watchMetricEventDeliveryHandler(ctx, { eventId: EVENT_ID });

    expect(runAfter).toHaveBeenCalledTimes(2);
    expect(runAfter.mock.calls.map(([delay]) => delay)).toEqual([0, 60_000]);
  });

  it("caps a late retry at the raw-payload privacy deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const createdAt = NOW - 86_400_000 + 500;
    const { ctx, patch, runAfter } = finishContext({ createdAt });

    await finishMetricEventDeliveryHandler(ctx, {
      eventId: EVENT_ID,
      outcome: "retry",
      leaseExpiresAt: NOW + 60_000,
      error: "HTTP 503",
    });

    expect(patch).toHaveBeenCalledWith(
      "outbox",
      expect.objectContaining({ state: "pending", nextAttemptAt: NOW + 500 }),
    );
    expect(runAfter).toHaveBeenCalledWith(500, expect.anything(), { eventId: EVENT_ID });
  });

  it("scrubs raw payload when the privacy-deadline watch fires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { ctx, patch, deleteRow, runAfter } = finishContext({
      createdAt: NOW - 86_400_000,
      state: "pending",
      nextAttemptAt: NOW,
    });

    await watchMetricEventDeliveryHandler(ctx, { eventId: EVENT_ID });

    expect(patch).toHaveBeenCalledWith(
      "claim",
      expect.objectContaining({ state: "terminal", completedAt: NOW }),
    );
    expect(deleteRow).toHaveBeenCalledWith("outbox");
    expect(runAfter).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
  });
});

function actionContext() {
  const runMutation = vi
    .fn()
    .mockResolvedValueOnce({
      endpoint: "https://splitch.test",
      request: {
        eventName: "model-generation",
        targetingKey: "user_123",
        idType: "user",
        eventId: EVENT_ID,
        fields: { generationCount: 1 },
        dimensions: { model: "claude-sonnet" },
      },
      leaseExpiresAt: NOW + 60_000,
    })
    .mockResolvedValue(null);
  return { ctx: { runMutation } as unknown as ActionCtx, runMutation };
}

function finishContext(
  overrides: Partial<{
    createdAt: number;
    state: "pending" | "delivering";
    nextAttemptAt: number;
  }> = {},
) {
  const patch = vi.fn().mockResolvedValue(undefined);
  const deleteRow = vi.fn().mockResolvedValue(undefined);
  const runAfter = vi.fn().mockResolvedValue("scheduled");
  const query = vi.fn((table: string) => ({
    withIndex: vi.fn(() => ({
      unique: vi.fn().mockResolvedValue(
        table === "metricEventOutbox"
          ? {
              _id: "outbox",
              eventId: EVENT_ID,
              createdAt: NOW - 1_000,
              state: "delivering",
              nextAttemptAt: NOW + 60_000,
              attemptCount: 0,
              ...overrides,
            }
          : table === "metricEventClaims"
            ? { _id: "claim", eventId: EVENT_ID, state: "queued" }
            : null,
      ),
    })),
  }));
  return {
    ctx: {
      db: { query, patch, delete: deleteRow },
      scheduler: { runAfter },
    } as unknown as MutationCtx,
    patch,
    deleteRow,
    runAfter,
  };
}
