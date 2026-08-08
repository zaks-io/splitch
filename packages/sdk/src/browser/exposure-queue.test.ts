import { describe, expect, it, vi } from "vitest";
import { EXPOSURE_BATCH_MAX_ITEMS } from "../generated/contract-surface.js";
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

describe("ExposureQueue: overlapping flush drain", () => {
  it("chains a second flush so later enqueues are sent (probe A / M34)", async () => {
    const gate = deferred<BrowserExposuresResult>();
    const redeemCalls: { size: number; keepalive?: boolean }[] = [];
    let firstBatch: readonly { exposureId: string }[] = [];
    let call = 0;
    const transport = {
      async redeemExposures(
        exposures: readonly { exposureId: string }[],
        options?: { keepalive?: boolean },
      ) {
        redeemCalls.push({ size: exposures.length, keepalive: options?.keepalive });
        call += 1;
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

    queue.enqueue("a", "ticket-a");
    const first = queue.flush();
    queue.enqueue("b", "ticket-b");
    const second = queue.flush();

    await vi.waitFor(() => {
      expect(firstBatch.length).toBe(1);
    });
    gate.resolve(acceptAll(firstBatch));
    await first;
    await second;

    expect(redeemCalls.length).toBe(2);
    expect(redeemCalls[0]?.size).toBe(1);
    expect(redeemCalls[1]?.size).toBe(1);
    expect(logger.errors).toHaveLength(0);
  });

  it("close drains remaining items after a partial ack (probe B)", async () => {
    let calls = 0;
    const redeemCalls: number[] = [];
    const drainingTransport = {
      async redeemExposures(exposures: readonly { exposureId: string }[]) {
        calls += 1;
        redeemCalls.push(exposures.length);
        if (calls === 1) {
          const first = exposures[0];
          if (first === undefined) {
            return { status: 202, results: [] };
          }
          return {
            status: 202,
            results: [{ exposureId: first.exposureId, status: "accepted" as const, code: null }],
          };
        }
        return acceptAll(exposures);
      },
    };

    const logger = new FakeLogger();
    const queue = new ExposureQueue({
      transport: drainingTransport,
      logger,
      now: () => Date.parse("2026-08-08T00:00:00.000Z"),
    });
    queue.enqueue("a", "ticket-a");
    queue.enqueue("b", "ticket-b");
    await queue.close();

    expect(redeemCalls.reduce((sum, n) => sum + n, 0)).toBeGreaterThanOrEqual(2);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(logger.errors).toHaveLength(0);
  });

  it("pagehide after an in-flight flush still sends remaining with keepalive (probe C)", async () => {
    const gate = deferred<BrowserExposuresResult>();
    const redeemCalls: { size: number; keepalive?: boolean }[] = [];
    let firstBatch: readonly { exposureId: string }[] = [];
    let call = 0;
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

    const transport = {
      async redeemExposures(
        exposures: readonly { exposureId: string }[],
        options?: { keepalive?: boolean },
      ) {
        redeemCalls.push({ size: exposures.length, keepalive: options?.keepalive });
        call += 1;
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
      window: fakeWindow,
      document: null,
    });

    queue.enqueue("a", "ticket-a");
    const inFlight = queue.flush();
    queue.enqueue("b", "ticket-b");
    for (const handler of listeners.get("pagehide") ?? []) {
      handler();
    }

    await vi.waitFor(() => {
      expect(firstBatch.length).toBe(1);
    });
    gate.resolve(acceptAll(firstBatch));
    await inFlight;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(redeemCalls.length).toBe(2);
    expect(redeemCalls[1]?.keepalive).toBe(true);
    expect(logger.errors).toHaveLength(0);
  });
});

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
        // Reordered: second rejected, first accepted — index correlation would mislabel.
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

  it("detachLifecycle on close removes pagehide listeners (M37)", async () => {
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
      transport: { redeemExposures: async (e) => acceptAll(e) },
      logger: new FakeLogger(),
      now: () => Date.now(),
      window: fakeWindow,
      document: null,
    });
    queue.enqueue("a", "ticket-a");
    expect(listeners.get("pagehide")?.size).toBe(1);
    await queue.close();
    expect(listeners.get("pagehide")?.size ?? 0).toBe(0);
  });
});
