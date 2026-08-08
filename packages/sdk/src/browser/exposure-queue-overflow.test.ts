import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXPOSURE_BATCH_MAX_ITEMS } from "../generated/contract-surface.js";
import { FakeLogger } from "../test-fixtures";
import { EXPOSURE_BATCH_FAILURE_RETRY_REMEDIATION } from "./exposure-drain";
import { ExposureQueue } from "./exposure-queue";
import type { BrowserExposuresResult } from "./transport";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

describe("ExposureQueue: overflow interleaving (R4)", () => {
  it("25-then-50 healthy interleave delivers all 75 with zero error logs", async () => {
    const gate = deferred<BrowserExposuresResult>();
    const redeemSizes: number[] = [];
    let call = 0;
    let firstBatch: readonly { exposureId: string }[] = [];
    const transport = {
      async redeemExposures(exposures: readonly { exposureId: string }[]) {
        call += 1;
        redeemSizes.push(exposures.length);
        if (call === 1) {
          firstBatch = exposures;
          return gate.promise;
        }
        return acceptAll(exposures);
      },
    };
    const logger = new FakeLogger();
    const queue = new ExposureQueue({
      transport,
      logger,
      now: () => Date.parse("2026-08-08T00:00:00.000Z"),
    });

    for (let i = 0; i < EXPOSURE_BATCH_MAX_ITEMS; i++) {
      queue.enqueue(`early-${i}`, `ticket-early-${i}`);
    }
    await vi.waitFor(() => {
      expect(firstBatch.length).toBe(EXPOSURE_BATCH_MAX_ITEMS);
    });
    for (let i = 0; i < 50; i++) {
      queue.enqueue(`late-${i}`, `ticket-late-${i}`);
    }
    gate.resolve(acceptAll(firstBatch));
    // flushOverflow #1 handed off at queuedDrains>1; drain remaining via flush.
    await queue.flush();

    expect(redeemSizes.reduce((a, b) => a + b, 0)).toBe(75);
    expect(redeemSizes.length).toBe(3);
    expect(logger.errors).toHaveLength(0);
  });

  it("close delivers every enqueued Exposure across healthy interleaved drains", async () => {
    const gate = deferred<BrowserExposuresResult>();
    let delivered = 0;
    let call = 0;
    let firstBatch: readonly { exposureId: string }[] = [];
    const transport = {
      async redeemExposures(exposures: readonly { exposureId: string }[]) {
        call += 1;
        delivered += exposures.length;
        if (call === 1) {
          firstBatch = exposures;
          return gate.promise;
        }
        return acceptAll(exposures);
      },
    };
    const logger = new FakeLogger();
    const queue = new ExposureQueue({
      transport,
      logger,
      now: () => Date.parse("2026-08-08T00:00:00.000Z"),
    });

    for (let i = 0; i < EXPOSURE_BATCH_MAX_ITEMS; i++) {
      queue.enqueue(`early-${i}`, `ticket-early-${i}`);
    }
    await vi.waitFor(() => {
      expect(firstBatch.length).toBe(EXPOSURE_BATCH_MAX_ITEMS);
    });
    for (let i = 0; i < 50; i++) {
      queue.enqueue(`late-${i}`, `ticket-late-${i}`);
    }
    const closing = queue.close();
    gate.resolve(acceptAll(firstBatch));
    await closing;

    expect(delivered).toBe(75);
    expect(logger.errors).toHaveLength(0);
  });
});

describe("ExposureQueue: retain-on-failure (R4)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("single 503 on a one-batch queue retains all and the 5s timer delivers them", async () => {
    let call = 0;
    const redeemSizes: number[] = [];
    const transport = {
      async redeemExposures(exposures: readonly { exposureId: string }[]) {
        call += 1;
        redeemSizes.push(exposures.length);
        if (call === 1) {
          return {
            status: 503,
            results: null,
            errorCode: "SERVICE_UNAVAILABLE" as const,
            errorMessage: "blip",
          };
        }
        return acceptAll(exposures);
      },
    };
    const logger = new FakeLogger();
    const queue = new ExposureQueue({
      transport,
      logger,
      now: () => Date.parse("2026-08-08T00:00:00.000Z"),
    });

    for (let i = 0; i < EXPOSURE_BATCH_MAX_ITEMS; i++) {
      queue.enqueue(`flag-${i}`, `ticket-${i}`);
    }
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(redeemSizes[0]).toBe(EXPOSURE_BATCH_MAX_ITEMS);
    expect(logger.errors.some((row) => row.message.includes("RATE_LIMITED"))).toBe(false);
    expect(
      logger.errors.some((row) => row.message.includes(EXPOSURE_BATCH_FAILURE_RETRY_REMEDIATION)),
    ).toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(redeemSizes).toEqual([EXPOSURE_BATCH_MAX_ITEMS, EXPOSURE_BATCH_MAX_ITEMS]);
    expect(logger.errors.some((row) => row.message.includes("RATE_LIMITED"))).toBe(false);
  });

  it("genuine overflow drops only the excess tail and retains one batch", async () => {
    const transport = {
      async redeemExposures(_exposures: readonly { exposureId: string }[]) {
        return {
          status: 503,
          results: null,
          errorCode: "SERVICE_UNAVAILABLE" as const,
          errorMessage: "down",
        };
      },
    };
    const logger = new FakeLogger();
    const queue = new ExposureQueue({
      transport,
      logger,
      now: () => Date.parse("2026-08-08T00:00:00.000Z"),
    });

    for (let i = 0; i < EXPOSURE_BATCH_MAX_ITEMS + 10; i++) {
      queue.enqueue(`flag-${i}`, `ticket-${i}`);
    }
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    const rateLimited = logger.errors.find((row) => row.message.includes("RATE_LIMITED"));
    expect(rateLimited).toBeDefined();
    expect(rateLimited?.message).toMatch(/dropped 10/);
    expect(rateLimited?.message).toMatch(/retained 25/);
    expect(rateLimited?.detail).toMatchObject({ droppedCount: 10, retainedCount: 25 });
    expect((rateLimited?.detail as { exposureIds: string[] }).exposureIds).toHaveLength(10);
  });
});

describe("ExposureQueue: afterDrain detach (R4)", () => {
  it("detaches lifecycle listeners once a drain empties the queue", async () => {
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
      transport: {
        async redeemExposures(exposures) {
          return acceptAll(exposures);
        },
      },
      logger: new FakeLogger(),
      now: () => Date.now(),
      window: fakeWindow,
      document: null,
    });
    queue.enqueue("a", "ticket-a");
    expect(listeners.get("pagehide")?.size).toBe(1);
    await queue.flush();
    expect(listeners.get("pagehide")?.size ?? 0).toBe(0);
  });
});
