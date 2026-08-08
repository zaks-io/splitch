import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EXPOSURE_BATCH_MAX_BODY_BYTES,
  EXPOSURE_BATCH_MAX_ITEMS,
} from "../generated/contract-surface.js";
import { FakeLogger } from "../test-fixtures";
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

describe("ExposureQueue: batch caps and overflow", () => {
  it("enqueue at item cap triggers a forced flush (M27)", async () => {
    const redeemCalls: number[] = [];
    const transport = {
      async redeemExposures(exposures: readonly { exposureId: string }[]) {
        redeemCalls.push(exposures.length);
        return acceptAll(exposures);
      },
    };
    const queue = new ExposureQueue({
      transport,
      logger: new FakeLogger(),
      now: () => Date.parse("2026-08-08T00:00:00.000Z"),
    });
    for (let i = 0; i < EXPOSURE_BATCH_MAX_ITEMS; i++) {
      queue.enqueue(`flag-${i}`, `ticket-${i}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(redeemCalls.length).toBeGreaterThan(0);
    expect(redeemCalls[0]).toBe(EXPOSURE_BATCH_MAX_ITEMS);
  });

  it("enqueue over byte cap triggers a forced flush (M28)", async () => {
    const redeemCalls: number[] = [];
    const transport = {
      async redeemExposures(exposures: readonly { exposureId: string }[]) {
        redeemCalls.push(exposures.length);
        return acceptAll(exposures);
      },
    };
    const queue = new ExposureQueue({
      transport,
      logger: new FakeLogger(),
      now: () => Date.parse("2026-08-08T00:00:00.000Z"),
    });
    const huge = "x".repeat(Math.floor(EXPOSURE_BATCH_MAX_BODY_BYTES / 2));
    queue.enqueue("a", huge);
    queue.enqueue("b", huge);
    queue.enqueue("c", huge);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(redeemCalls.length).toBeGreaterThan(0);
  });

  it("splits at EXPOSURE_BATCH_MAX_ITEMS on flush", async () => {
    const redeemCalls: number[] = [];
    const transport = {
      async redeemExposures(exposures: readonly { exposureId: string }[]) {
        redeemCalls.push(exposures.length);
        return acceptAll(exposures);
      },
    };
    const queue = new ExposureQueue({
      transport,
      logger: new FakeLogger(),
      now: () => Date.parse("2026-08-08T00:00:00.000Z"),
    });
    for (let i = 0; i < EXPOSURE_BATCH_MAX_ITEMS + 1; i++) {
      queue.enqueue(`flag-${i}`, `ticket-${i}`);
    }
    await queue.flush();
    expect(redeemCalls.reduce((sum, n) => sum + n, 0)).toBe(EXPOSURE_BATCH_MAX_ITEMS + 1);
    expect(Math.max(...redeemCalls)).toBe(EXPOSURE_BATCH_MAX_ITEMS);
  });

  it("overflow drop path logs RATE_LIMITED with droppedCount (M35/B8)", async () => {
    const gate = deferred<BrowserExposuresResult>();
    let call = 0;
    let firstBatch: readonly { exposureId: string }[] = [];
    const transport = {
      async redeemExposures(exposures: readonly { exposureId: string }[]) {
        call += 1;
        if (call === 1) {
          firstBatch = exposures;
          return gate.promise;
        }
        return {
          status: null,
          results: null,
          errorCode: "SDK_TRANSPORT_NETWORK" as const,
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

    queue.enqueue("a", "ticket-a");
    const first = queue.flush();
    // Exceed one batch so a failed forced flush drops only the excess tail.
    for (let i = 0; i < EXPOSURE_BATCH_MAX_ITEMS + 5; i++) {
      queue.enqueue(`flag-${i}`, `ticket-${i}`);
    }
    await vi.waitFor(() => {
      expect(firstBatch.length).toBe(1);
    });
    gate.resolve(acceptAll(firstBatch));
    await first.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const rateLimited = logger.errors.find((row) => row.message.includes("RATE_LIMITED"));
    expect(rateLimited).toBeDefined();
    expect(rateLimited?.detail).toMatchObject({
      droppedCount: expect.any(Number),
      retainedCount: expect.any(Number),
    });
    expect((rateLimited?.detail as { droppedCount: number }).droppedCount).toBeGreaterThan(0);
    expect((rateLimited?.detail as { retainedCount: number }).retainedCount).toBe(
      EXPOSURE_BATCH_MAX_ITEMS,
    );
  });
});

describe("ExposureQueue: visibility + timer (M38/M39)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("visibilitychange fires keepalive only when hidden (M38)", async () => {
    const redeemCalls: { keepalive?: boolean }[] = [];
    let visibilityState: Document["visibilityState"] = "visible";
    const listeners = new Map<string, Set<() => void>>();
    const fakeDocument = {
      get visibilityState() {
        return visibilityState;
      },
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
    } as unknown as Document;

    const queue = new ExposureQueue({
      transport: {
        async redeemExposures(exposures, options) {
          redeemCalls.push({ keepalive: options?.keepalive });
          return acceptAll(exposures);
        },
      },
      logger: new FakeLogger(),
      now: () => Date.parse("2026-08-08T00:00:00.000Z"),
      document: fakeDocument,
      window: null,
    });
    queue.enqueue("a", "ticket-a");

    visibilityState = "visible";
    for (const handler of listeners.get("visibilitychange") ?? []) {
      handler();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(redeemCalls).toHaveLength(0);

    visibilityState = "hidden";
    for (const handler of listeners.get("visibilitychange") ?? []) {
      handler();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(redeemCalls.length).toBeGreaterThan(0);
    expect(redeemCalls[0]?.keepalive).toBe(true);
  });

  it("5s timer auto-flushes without an explicit flush() (M39)", async () => {
    const redeemCalls: number[] = [];
    const queue = new ExposureQueue({
      transport: {
        async redeemExposures(exposures) {
          redeemCalls.push(exposures.length);
          return acceptAll(exposures);
        },
      },
      logger: new FakeLogger(),
      now: () => Date.parse("2026-08-08T00:00:00.000Z"),
    });
    queue.enqueue("a", "ticket-a");
    expect(redeemCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(redeemCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(redeemCalls).toEqual([1]);
  });

  it("re-arms the 5s timer after a failed auto-flush (B1)", async () => {
    let call = 0;
    const redeemCalls: number[] = [];
    const queue = new ExposureQueue({
      transport: {
        async redeemExposures(exposures) {
          call += 1;
          redeemCalls.push(exposures.length);
          if (call === 1) {
            return {
              status: null,
              results: null,
              errorCode: "SDK_TRANSPORT_NETWORK" as const,
              errorMessage: "blip",
            };
          }
          return acceptAll(exposures);
        },
      },
      logger: new FakeLogger(),
      now: () => Date.parse("2026-08-08T00:00:00.000Z"),
    });
    queue.enqueue("a", "ticket-a");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(redeemCalls).toEqual([1]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(redeemCalls).toEqual([1, 1]);
  });

  it("close() clears the armed timer so a failed drain is not retried 5s later", async () => {
    const redeemCalls: number[] = [];
    const queue = new ExposureQueue({
      transport: {
        async redeemExposures(exposures) {
          redeemCalls.push(exposures.length);
          return {
            status: 503,
            results: null,
            errorCode: "SERVICE_UNAVAILABLE" as const,
            errorMessage: "blip",
          };
        },
      },
      logger: new FakeLogger(),
      now: () => Date.parse("2026-08-08T00:00:00.000Z"),
    });
    queue.enqueue("a", "ticket-a");
    await expect(queue.close()).rejects.toThrow(/SERVICE_UNAVAILABLE/);
    expect(redeemCalls).toEqual([1]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(redeemCalls).toEqual([1]);
  });
});
