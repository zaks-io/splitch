import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXPOSURE_BATCH_MAX_ITEMS } from "../generated/contract-surface.js";
import { FakeLogger } from "../test-fixtures";
import { ExposureQueue } from "./exposure-queue";
import type { BrowserExposuresResult } from "./transport";

function rejectAll(exposures: readonly { exposureId: string }[]): BrowserExposuresResult {
  return {
    status: 202,
    results: exposures.map((item) => ({
      exposureId: item.exposureId,
      status: "rejected" as const,
      code: "SERVICE_UNAVAILABLE" as const,
    })),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function pendingLength(queue: ExposureQueue): number {
  return (queue as unknown as { pending: unknown[] }).pending.length;
}

function queuedDrainCount(queue: ExposureQueue): number {
  return (queue as unknown as { queuedDrains: number }).queuedDrains;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ExposureQueue: adversarial automatic drains", () => {
  it("trims overflow after an all-items retryable rejection", async () => {
    const logger = new FakeLogger();
    const queue = new ExposureQueue({
      transport: { redeemExposures: vi.fn(async (exposures) => rejectAll(exposures)) },
      logger,
      now: () => Date.parse("2026-08-08T00:00:00.000Z"),
    });

    for (let i = 0; i < 200; i++) {
      queue.enqueue(`flag-${i}`, `ticket-${i}`);
    }
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => {
      expect(queuedDrainCount(queue)).toBe(0);
    });

    expect(pendingLength(queue)).toBe(EXPOSURE_BATCH_MAX_ITEMS);
    const rateLimited = logger.errors.filter((row) => row.message.includes("RATE_LIMITED"));
    expect(rateLimited.length).toBeGreaterThan(0);
    expect(rateLimited.reduce((sum, row) => sum + Number(row.detail.droppedCount), 0)).toBe(175);
    expect(rateLimited.every((row) => row.detail.retainedCount === 25)).toBe(true);
  });

  it("blocks queued and new automatic drains after terminal stop but permits flush", async () => {
    const logger = new FakeLogger();
    const thirdAttempt = deferred<BrowserExposuresResult>();
    let thirdBatch: readonly { exposureId: string }[] = [];
    const redeemExposures = vi.fn(async (exposures: readonly { exposureId: string }[]) => {
      if (redeemExposures.mock.calls.length === 3) {
        thirdBatch = exposures;
        return thirdAttempt.promise;
      }
      return rejectAll(exposures);
    });
    const queue = new ExposureQueue({
      transport: { redeemExposures },
      logger,
      now: () => Date.parse("2026-08-08T00:00:00.000Z"),
    });

    for (let i = 0; i < EXPOSURE_BATCH_MAX_ITEMS; i++) {
      queue.enqueue(`flag-${i}`, `ticket-${i}`);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(redeemExposures).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(redeemExposures).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(redeemExposures).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 35; i++) {
      queue.enqueue(`queued-${i}`, `ticket-queued-${i}`);
    }
    thirdAttempt.resolve(rejectAll(thirdBatch));
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => {
      expect(queuedDrainCount(queue)).toBe(0);
    });

    expect(redeemExposures).toHaveBeenCalledTimes(3);
    expect(logger.errors.filter((row) => row.detail.automaticRetryStopped === true)).toHaveLength(
      1,
    );

    queue.enqueue("after-stop", "ticket-after-stop");
    await vi.advanceTimersByTimeAsync(0);
    expect(redeemExposures).toHaveBeenCalledTimes(3);

    await queue.flush();
    expect(redeemExposures).toHaveBeenCalledTimes(4);
  });
});
