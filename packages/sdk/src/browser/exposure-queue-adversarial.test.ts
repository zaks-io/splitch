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

function controlledTransport() {
  const state = { inFlight: 0, maxInFlight: 0 };
  const calls: Array<{
    readonly exposures: readonly { exposureId: string }[];
    released: boolean;
    release: (result: BrowserExposuresResult) => void;
  }> = [];
  return {
    state,
    calls,
    transport: {
      redeemExposures(exposures: readonly { exposureId: string }[]) {
        state.inFlight += 1;
        state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
        return new Promise<BrowserExposuresResult>((resolve) => {
          const call = {
            exposures,
            released: false,
            release(result: BrowserExposuresResult) {
              if (call.released) {
                return;
              }
              call.released = true;
              state.inFlight -= 1;
              resolve(result);
            },
          };
          calls.push(call);
        });
      },
    },
  };
}

const LARGE_TICKET = "t".repeat(4_500);

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
  it("serializes byte-capped retryable drains and preserves the three-attempt bound", async () => {
    const controlled = controlledTransport();
    const queue = new ExposureQueue({
      transport: controlled.transport,
      logger: new FakeLogger(),
      now: () => Date.parse("2026-08-08T00:00:00.000Z"),
    });

    for (let i = 0; i < 60; i++) {
      queue.enqueue(`byte-flag-${i}`, `${LARGE_TICKET}-${i}`);
    }
    expect(controlled.calls).toHaveLength(1);
    const first = controlled.calls[0];
    if (first === undefined) {
      throw new Error("expected the first byte-capped batch");
    }
    expect(first.exposures).toHaveLength(7);

    first.release(rejectAll(first.exposures));
    await vi.waitFor(() => {
      expect(controlled.calls.length).toBeGreaterThan(1);
    });

    for (let pass = 0; pass < 20 && queuedDrainCount(queue) > 0; pass++) {
      for (const call of controlled.calls.filter((candidate) => !candidate.released)) {
        call.release(rejectAll(call.exposures));
      }
      await vi.advanceTimersByTimeAsync(0);
    }

    expect(queuedDrainCount(queue)).toBe(0);
    expect(controlled.state.inFlight).toBe(0);
    expect({
      automaticCalls: controlled.calls.length,
      maxInFlight: controlled.state.maxInFlight,
    }).toEqual({ automaticCalls: 3, maxInFlight: 1 });
  });

  it("does not resolve close while a byte-capped batch remains in flight", async () => {
    const controlled = controlledTransport();
    const queue = new ExposureQueue({
      transport: controlled.transport,
      logger: new FakeLogger(),
      now: () => Date.parse("2026-08-08T00:00:00.000Z"),
    });

    for (let i = 0; i < 60; i++) {
      queue.enqueue(`close-flag-${i}`, `${LARGE_TICKET}-${i}`);
    }
    const first = controlled.calls[0];
    if (first === undefined) {
      throw new Error("expected the first byte-capped batch");
    }
    first.release(acceptAll(first.exposures));
    await vi.waitFor(() => {
      expect(controlled.calls.length).toBeGreaterThan(1);
    });

    let closeResolved = false;
    const closing = queue.close().then((results) => {
      closeResolved = true;
      return results;
    });
    for (let pass = 0; pass < 20 && !closeResolved; pass++) {
      const latest = controlled.calls.findLast((call) => !call.released);
      latest?.release(acceptAll(latest.exposures));
      await vi.advanceTimersByTimeAsync(0);
    }
    await closing;
    const inFlightWhenCloseResolved = controlled.state.inFlight;

    for (const call of controlled.calls.filter((candidate) => !candidate.released)) {
      call.release(acceptAll(call.exposures));
    }
    await vi.advanceTimersByTimeAsync(0);

    expect({ inFlightWhenCloseResolved, maxInFlight: controlled.state.maxInFlight }).toEqual({
      inFlightWhenCloseResolved: 0,
      maxInFlight: 1,
    });
  });

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
