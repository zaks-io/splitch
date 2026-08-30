import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import { DELIVERY_LEASE_MS } from "./delivery_policy";
import { drainExposuresHandler } from "./exposure_batch";
import { watchDeliveryHandler } from "./exposure_delivery";

const NOW = 1_800_000_000_000;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Exposure batch drain", () => {
  it("sends one request for a full 25-item batch and settles every result together", async () => {
    const rows = Array.from({ length: 25 }, (_, index) => deliveryRow(index));
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce({
        endpoint: "https://edge.splitch.dev",
        rows,
        leaseExpiresAt: NOW + DELIVERY_LEASE_MS,
      })
      .mockResolvedValueOnce(null);
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        results: rows.map((row) => ({ exposureId: row.exposureId, status: "accepted" })),
      }),
    );
    vi.stubGlobal("fetch", fetch);

    await drainExposuresHandler({ runMutation } as unknown as ActionCtx);

    expect(fetch).toHaveBeenCalledOnce();
    const request = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(request.body as string).exposures).toHaveLength(25);
    expect(runMutation).toHaveBeenCalledTimes(2);
    expect(runMutation.mock.calls[1]?.[1]).toEqual({
      leaseExpiresAt: NOW + DELIVERY_LEASE_MS,
      results: rows.map((row) => ({ exposureId: row.exposureId, outcome: "accepted" })),
    });
  });

  it("retries omitted and retryable items without replaying accepted siblings", async () => {
    const rows = [deliveryRow(0), deliveryRow(1), deliveryRow(2)];
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce({ endpoint: "https://edge.splitch.dev", rows, leaseExpiresAt: NOW })
      .mockResolvedValueOnce(null);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          results: [
            { exposureId: rows[0]?.exposureId, status: "deduplicated" },
            { exposureId: rows[1]?.exposureId, status: "rejected", retryable: true },
          ],
        }),
      ),
    );

    await drainExposuresHandler({ runMutation } as unknown as ActionCtx);

    expect(runMutation.mock.calls[1]?.[1]).toEqual({
      leaseExpiresAt: NOW,
      results: [
        { exposureId: rows[0]?.exposureId, outcome: "accepted" },
        {
          exposureId: rows[1]?.exposureId,
          outcome: "retry",
          error: "Exposure delivery was rejected",
        },
        {
          exposureId: rows[2]?.exposureId,
          outcome: "retry",
          error: "Exposure batch response omitted the item result",
        },
      ],
    });
  });
});

describe("Exposure delivery recovery watch", () => {
  it("stops after the outbox row is gone", async () => {
    const { ctx, runAfter } = fakeContext(null);

    await watchDeliveryHandler(ctx, { exposureId: "exp_1" });

    expect(runAfter).not.toHaveBeenCalled();
  });

  it("waits through a pending attempt and its lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const nextAttemptAt = NOW + 5_000;
    const { ctx, runAfter } = fakeContext({
      exposureId: "exp_1",
      state: "pending",
      nextAttemptAt,
    });

    await watchDeliveryHandler(ctx, { exposureId: "exp_1" });

    expect(runAfter).toHaveBeenCalledOnce();
    expect(runAfter.mock.calls[0]?.[0]).toBe(5_000 + DELIVERY_LEASE_MS);
  });

  it("rechecks an active delivery when its lease expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { ctx, runAfter } = fakeContext({
      exposureId: "exp_1",
      state: "delivering",
      nextAttemptAt: NOW + 5_000,
    });

    await watchDeliveryHandler(ctx, { exposureId: "exp_1" });

    expect(runAfter).toHaveBeenCalledOnce();
    expect(runAfter.mock.calls[0]?.[0]).toBe(5_000);
  });

  it("restarts a due delivery and leaves one recovery watch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { ctx, runAfter } = fakeContext({
      exposureId: "exp_1",
      state: "delivering",
      nextAttemptAt: NOW,
    });

    await watchDeliveryHandler(ctx, { exposureId: "exp_1" });

    expect(runAfter).toHaveBeenCalledTimes(2);
    expect(runAfter.mock.calls.map(([delay]) => delay)).toEqual([0, DELIVERY_LEASE_MS]);
  });
});

function fakeContext(
  row: null | { exposureId: string; state: "pending" | "delivering"; nextAttemptAt: number },
): { ctx: MutationCtx; runAfter: ReturnType<typeof vi.fn> } {
  const runAfter = vi.fn().mockResolvedValue("scheduled_job");
  const unique = vi.fn().mockResolvedValue(row);
  const withIndex = vi.fn().mockReturnValue({ unique });
  const query = vi.fn().mockReturnValue({ withIndex });
  return {
    ctx: { db: { query }, scheduler: { runAfter } } as unknown as MutationCtx,
    runAfter,
  };
}

function deliveryRow(index: number) {
  return {
    exposureId: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
    installationId: "00000000-0000-4000-8000-000000000100",
    flagKey: "checkout",
    experimentId: "experiment_1",
    runId: "run_1",
    runConfigHash: "sha256:run-1",
    evaluationContext: { targetingKey: `entity_${index}`, idType: "user", attributes: {} },
    variantName: "treatment",
    exposureAt: "2026-08-30T00:00:00.000Z",
  };
}
