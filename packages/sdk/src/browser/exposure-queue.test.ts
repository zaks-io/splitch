import { describe, expect, it } from "vitest";
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
  it("chains a second flush so later enqueues are sent (probe A)", async () => {
    const gate = deferred<BrowserExposuresResult>();
    const redeemCalls: { size: number; keepalive?: boolean }[] = [];
    let call = 0;
    const transport = {
      async redeemExposures(
        exposures: readonly { exposureId: string }[],
        options?: { keepalive?: boolean },
      ) {
        redeemCalls.push({ size: exposures.length, keepalive: options?.keepalive });
        call += 1;
        if (call === 1) {
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

    gate.resolve(acceptAll([{ exposureId: "11111111-1111-4111-8111-111111111111" }]));
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

    gate.resolve(acceptAll([{ exposureId: "11111111-1111-4111-8111-111111111111" }]));
    await inFlight;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(redeemCalls.length).toBe(2);
    expect(redeemCalls[1]?.keepalive).toBe(true);
    expect(logger.errors).toHaveLength(0);
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
});

describe("ExposureQueue: batch caps", () => {
  it("splits at EXPOSURE_BATCH_MAX_ITEMS", async () => {
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
    expect(redeemCalls[0]).toBe(EXPOSURE_BATCH_MAX_ITEMS);
    expect(redeemCalls.reduce((sum, n) => sum + n, 0)).toBe(EXPOSURE_BATCH_MAX_ITEMS + 1);
  });

  it("byte cap forces a smaller batch before the item cap", async () => {
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
    const huge = "x".repeat(20_000);
    queue.enqueue("a", huge);
    queue.enqueue("b", huge);
    queue.enqueue("c", huge);
    await queue.flush();
    expect(redeemCalls.length).toBeGreaterThan(1);
    expect(Math.max(...redeemCalls)).toBeLessThan(3);
  });

  it("overflow drop path logs when a forced flush fails", async () => {
    const gate = deferred<BrowserExposuresResult>();
    let call = 0;
    const transport = {
      async redeemExposures(_exposures: readonly { exposureId: string }[]) {
        call += 1;
        if (call === 1) {
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
    for (let i = 0; i < EXPOSURE_BATCH_MAX_ITEMS; i++) {
      queue.enqueue(`flag-${i}`, `ticket-${i}`);
    }
    gate.resolve(acceptAll([{ exposureId: "11111111-1111-4111-8111-111111111111" }]));
    await first.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      logger.errors.some(
        (row) =>
          row.message.includes("RATE_LIMITED") || row.message.includes("SDK_TRANSPORT_NETWORK"),
      ),
    ).toBe(true);
  });
});
