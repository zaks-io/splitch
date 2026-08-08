import { describe, expect, it, vi } from "vitest";
import { EXPOSURE_BATCH_MAX_ITEMS } from "../generated/contract-surface.js";
import { FakeLogger } from "../test-fixtures";
import { ExposureQueue } from "./exposure-queue";
import type { BrowserExposuresResult } from "./transport";

function acceptAll(exposures: readonly { exposureId: string }[]): BrowserExposuresResult {
  return {
    status: 202,
    results: exposures.map((item) => ({
      exposureId: item.exposureId,
      status: "accepted" as const,
      code: null,
    })),
  };
}

function networkFail(): BrowserExposuresResult {
  return {
    status: null,
    results: null,
    errorCode: "SDK_TRANSPORT_NETWORK",
    errorMessage: "network down",
  };
}

describe("ExposureQueue: empty results fail loud (B3)", () => {
  it("throws on a contract-valid empty results array instead of spinning", async () => {
    let redeemCalls = 0;
    const transport = {
      async redeemExposures() {
        redeemCalls += 1;
        if (redeemCalls > 20) {
          throw new Error("PROBE: runaway drain loop");
        }
        return { status: 202, results: [] };
      },
    };
    const logger = new FakeLogger();
    const queue = new ExposureQueue({
      transport,
      logger,
      now: () => Date.parse("2026-08-08T00:00:00.000Z"),
    });
    queue.enqueue("a", "ticket-a");
    await expect(queue.flush()).rejects.toThrow(/zero progress/);
    expect(redeemCalls).toBe(1);
    expect(logger.errors.some((row) => row.message.includes("zero progress"))).toBe(true);
  });

  it("correlates rejected rows by exposureId, not array index (M32)", async () => {
    const logger = new FakeLogger();
    const idA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const idB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let n = 0;
    const transport = {
      async redeemExposures(exposures: readonly { exposureId: string }[]) {
        const first = exposures[0];
        const second = exposures[1];
        if (first === undefined || second === undefined) {
          return acceptAll(exposures);
        }
        return {
          status: 202,
          results: [
            {
              exposureId: second.exposureId,
              status: "rejected" as const,
              code: "VALIDATION_ERROR",
            },
            { exposureId: first.exposureId, status: "accepted" as const, code: null },
          ],
        };
      },
    };
    vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => {
      n += 1;
      return n === 1 ? idA : idB;
    });
    const queue = new ExposureQueue({
      transport,
      logger,
      now: () => Date.parse("2026-08-08T00:00:00.000Z"),
    });
    queue.enqueue("flag-a", "ticket-a");
    queue.enqueue("flag-b", "ticket-b");
    await queue.flush();
    const rejected = logger.errors.find((row) => row.message.includes("rejected"));
    expect(rejected).toBeDefined();
    expect(rejected?.detail).toMatchObject({ exposureId: idB, flagKey: "flag-b" });
    vi.restoreAllMocks();
  });

  it("throws when maxBatchesPerDrain is exceeded on a healthy stream", async () => {
    const transport = {
      async redeemExposures(exposures: readonly { exposureId: string }[]) {
        return acceptAll(exposures);
      },
    };
    const logger = new FakeLogger();
    const queue = new ExposureQueue({
      transport,
      logger,
      now: () => Date.parse("2026-08-08T00:00:00.000Z"),
      // Zero means the bound fires before any redeem — proves the guard is live.
      maxBatchesPerDrain: 0,
    });
    queue.enqueue("a", "ticket-a");
    await expect(queue.flush()).rejects.toThrow(/exceeded 0 batches/);
    expect(logger.errors.some((row) => row.message.includes("exceeded 0 batches"))).toBe(true);
  });
});

describe("ExposureQueue: close drain", () => {
  it("close drains multiple batches when more than the item cap is queued (probe D)", async () => {
    const redeemCalls: number[] = [];
    const transport = {
      async redeemExposures(exposures: readonly { exposureId: string }[]) {
        redeemCalls.push(exposures.length);
        return acceptAll(exposures);
      },
    };
    const logger = new FakeLogger();
    const queue = new ExposureQueue({
      transport,
      logger,
      now: () => Date.parse("2026-08-08T00:00:00.000Z"),
    });

    const total = EXPOSURE_BATCH_MAX_ITEMS + 5;
    for (let i = 0; i < total; i++) {
      queue.enqueue(`flag-${i}`, `ticket-${i}`);
    }
    await queue.close();

    expect(redeemCalls.reduce((sum, n) => sum + n, 0)).toBe(total);
    expect(logger.errors).toHaveLength(0);
  });

  it("logs when enqueue happens after close", async () => {
    const logger = new FakeLogger();
    const queue = new ExposureQueue({
      transport: { redeemExposures: async () => acceptAll([]) },
      logger,
      now: () => Date.now(),
    });
    await queue.close();
    queue.enqueue("late", "ticket");
    expect(logger.errors.some((row) => row.message.includes("after close()"))).toBe(true);
  });

  it("close finally detaches lifecycle even when drain fails (B4/M37)", async () => {
    const listeners = new Map<string, Set<() => void>>();
    const fakeWindow = {
      addEventListener(type: string, handler: () => void) {
        let set = listeners.get(type);
        if (set === undefined) {
          set = new Set();
          listeners.set(type, set);
        }
        set.add(handler);
      },
      removeEventListener(type: string, handler: () => void) {
        listeners.get(type)?.delete(handler);
      },
    } as unknown as Window;
    const queue = new ExposureQueue({
      transport: { redeemExposures: async () => networkFail() },
      logger: new FakeLogger(),
      now: () => Date.now(),
      window: fakeWindow,
      document: null,
    });
    queue.enqueue("a", "ticket-a");
    expect(listeners.get("pagehide")?.size).toBe(1);
    await expect(queue.close()).rejects.toThrow();
    expect(listeners.get("pagehide")?.size ?? 0).toBe(0);
  });
});

describe("ExposureQueue: rejecting transport re-queues (R2)", () => {
  function pendingLength(queue: ExposureQueue): number {
    return (queue as unknown as { pending: unknown[] }).pending.length;
  }

  it("flush() re-queues and logs when redeemExposures throws", async () => {
    const redeemIds: string[][] = [];
    let shouldReject = true;
    const logger = new FakeLogger();
    const queue = new ExposureQueue({
      transport: {
        async redeemExposures(exposures) {
          redeemIds.push(exposures.map((row) => row.exposureId));
          if (shouldReject) {
            throw new Error("custom transport blew up");
          }
          return acceptAll(exposures);
        },
      },
      logger,
      now: () => Date.parse("2026-08-08T00:00:00.000Z"),
    });
    queue.enqueue("a", "ticket-a");
    expect(pendingLength(queue)).toBe(1);
    expect(logger.errors).toHaveLength(0);

    await expect(queue.flush()).rejects.toThrow(/custom transport blew up/);
    expect(pendingLength(queue)).toBe(1);
    expect(logger.errors.length).toBeGreaterThanOrEqual(1);
    expect(logger.errors.some((row) => row.message.includes("custom transport blew up"))).toBe(
      true,
    );

    shouldReject = false;
    await expect(queue.flush()).resolves.toHaveLength(1);
    expect(pendingLength(queue)).toBe(0);
    expect(redeemIds).toHaveLength(2);
    expect(redeemIds[0]).toEqual(redeemIds[1]);
  });

  it("5s timer re-queues and logs when redeemExposures throws", async () => {
    vi.useFakeTimers();
    try {
      const redeemIds: string[][] = [];
      let shouldReject = true;
      const logger = new FakeLogger();
      const queue = new ExposureQueue({
        transport: {
          async redeemExposures(exposures) {
            redeemIds.push(exposures.map((row) => row.exposureId));
            if (shouldReject) {
              throw new Error("timer transport blew up");
            }
            return acceptAll(exposures);
          },
        },
        logger,
        now: () => Date.parse("2026-08-08T00:00:00.000Z"),
      });
      queue.enqueue("a", "ticket-a");
      expect(pendingLength(queue)).toBe(1);
      expect(logger.errors).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.resolve();
      expect(pendingLength(queue)).toBe(1);
      expect(logger.errors.length).toBeGreaterThanOrEqual(1);
      expect(logger.errors.some((row) => row.message.includes("timer transport blew up"))).toBe(
        true,
      );

      shouldReject = false;
      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.resolve();
      expect(pendingLength(queue)).toBe(0);
      expect(redeemIds.length).toBeGreaterThanOrEqual(2);
      expect(redeemIds[0]).toEqual(redeemIds[1]);
    } finally {
      vi.useRealTimers();
    }
  });
});
