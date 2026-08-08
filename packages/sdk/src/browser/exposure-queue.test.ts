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

function networkFail(): BrowserExposuresResult {
  return {
    status: null,
    results: null,
    errorCode: "SDK_TRANSPORT_NETWORK",
    errorMessage: "network down",
  };
}

describe("ExposureQueue: overlapping flush drain", () => {
  it("second flush starts only after the first drain resolves (probe A / M34)", async () => {
    const gate = deferred<BrowserExposuresResult>();
    const events: string[] = [];
    let firstBatch: readonly { exposureId: string }[] = [];
    let call = 0;
    const transport = {
      async redeemExposures(exposures: readonly { exposureId: string }[]) {
        call += 1;
        events.push(`call-${call}-start`);
        if (call === 1) {
          firstBatch = exposures;
          const result = await gate.promise;
          events.push("call-1-end");
          return result;
        }
        events.push("call-2-end");
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
    expect(events).toEqual(["call-1-start"]);
    gate.resolve(acceptAll(firstBatch));
    await first;
    await second;

    expect(events).toEqual(["call-1-start", "call-1-end", "call-2-start", "call-2-end"]);
    expect(logger.errors).toHaveLength(0);
  });

  it("close still sends after an in-flight drain fails (B2)", async () => {
    const gate = deferred<BrowserExposuresResult>();
    const redeemCalls: number[] = [];
    let call = 0;
    let firstBatch: readonly { exposureId: string }[] = [];
    const transport = {
      async redeemExposures(exposures: readonly { exposureId: string }[]) {
        call += 1;
        redeemCalls.push(exposures.length);
        if (call === 1) {
          firstBatch = exposures;
          return gate.promise;
        }
        return acceptAll(exposures);
      },
    };
    const queue = new ExposureQueue({
      transport,
      logger: new FakeLogger(),
      now: () => Date.parse("2026-08-08T00:00:00.000Z"),
    });

    queue.enqueue("a", "ticket-a");
    const first = queue.flush();
    await vi.waitFor(() => {
      expect(firstBatch.length).toBe(1);
    });
    const closing = queue.close();
    gate.resolve(networkFail());
    await expect(first).rejects.toThrow(/SDK_TRANSPORT_NETWORK|network down/);
    await closing;
    expect(redeemCalls.length).toBe(2);
    expect(redeemCalls[1]).toBe(1);
  });
});

describe("ExposureQueue: overlapping flush drain (handoff)", () => {
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
