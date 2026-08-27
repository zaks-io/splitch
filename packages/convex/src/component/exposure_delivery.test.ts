import { afterEach, describe, expect, it, vi } from "vitest";
import type { MutationCtx } from "./_generated/server";
import { DELIVERY_LEASE_MS, watchDeliveryHandler } from "./exposure_delivery";

const NOW = 1_800_000_000_000;

afterEach(() => {
  vi.useRealTimers();
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
