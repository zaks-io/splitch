import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeLogger } from "../test-fixtures";
import { ExposureQueue } from "./exposure-queue";
import type { BrowserExposuresResult } from "./transport";

function failure(status: number): BrowserExposuresResult {
  return {
    status,
    results: null,
    errorCode: status === 401 ? "UNAUTHORIZED" : "SERVICE_UNAVAILABLE",
    errorMessage: `HTTP ${status}`,
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

describe("ExposureQueue: bounded automatic retries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops immediately on a terminal 401 and logs the terminal attempt", async () => {
    const logger = new FakeLogger();
    const redeemCalls: string[][] = [];
    const queue = new ExposureQueue({
      transport: {
        async redeemExposures(exposures) {
          redeemCalls.push(exposures.map((item) => item.exposureId));
          return failure(401);
        },
      },
      logger,
      now: () => Date.parse("2026-08-08T00:00:00.000Z"),
    });

    queue.enqueue("flag", "ticket");
    await vi.advanceTimersByTimeAsync(30_000);

    expect(redeemCalls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    const terminal = logger.errors.find((row) => row.detail.automaticRetryStopped === true);
    expect(terminal?.message).toContain("non-retryable HTTP 401");
    expect(terminal?.detail).toMatchObject({
      status: 401,
      errorCode: "UNAUTHORIZED",
      attemptCount: 1,
      automaticRetryStopped: true,
    });
    expect(logger.errors.some((row) => row.message.includes("Automatic retries stopped"))).toBe(
      true,
    );
  });

  it("retries a transient failure with the original exposureId", async () => {
    const logger = new FakeLogger();
    const redeemCalls: string[][] = [];
    let calls = 0;
    const queue = new ExposureQueue({
      transport: {
        async redeemExposures(exposures) {
          calls += 1;
          redeemCalls.push(exposures.map((item) => item.exposureId));
          return calls === 1 ? failure(503) : acceptAll(exposures);
        },
      },
      logger,
      now: () => Date.parse("2026-08-08T00:00:00.000Z"),
    });

    queue.enqueue("flag", "ticket");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(redeemCalls).toHaveLength(2);
    expect(redeemCalls[1]).toEqual(redeemCalls[0]);
    expect(logger.errors.some((row) => row.detail.automaticRetryStopped === true)).toBe(false);
  });

  it("stops a persistent retryable failure after three delivery attempts", async () => {
    const logger = new FakeLogger();
    const redeemCalls: string[][] = [];
    const queue = new ExposureQueue({
      transport: {
        async redeemExposures(exposures) {
          redeemCalls.push(exposures.map((item) => item.exposureId));
          return failure(503);
        },
      },
      logger,
      now: () => Date.parse("2026-08-08T00:00:00.000Z"),
    });

    queue.enqueue("flag", "ticket");
    await vi.advanceTimersByTimeAsync(30_000);

    expect(redeemCalls).toHaveLength(3);
    expect(redeemCalls.every((ids) => ids[0] === redeemCalls[0]?.[0])).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const terminal = logger.errors.find((row) => row.detail.automaticRetryStopped === true);
    expect(terminal?.message).toContain("stopped after 3 failed attempts");
    expect(terminal?.detail).toMatchObject({ status: 503, attemptCount: 3 });
  });
});
