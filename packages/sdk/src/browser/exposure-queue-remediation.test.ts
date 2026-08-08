import { describe, expect, it, vi } from "vitest";
import { FakeLogger } from "../test-fixtures";
import {
  EXPOSURE_BATCH_FAILURE_NO_RETRY_REMEDIATION,
  EXPOSURE_BATCH_FAILURE_RETRY_REMEDIATION,
} from "./exposure-drain";
import { ExposureQueue } from "./exposure-queue";
import type { BrowserExposuresResult } from "./transport";

function unavailable(): BrowserExposuresResult {
  return {
    status: 503,
    results: null,
    errorCode: "SERVICE_UNAVAILABLE",
    errorMessage: "blip",
  };
}

function batchFailureMessage(logger: FakeLogger): string {
  const row = logger.errors.find((entry) => entry.message.includes("SERVICE_UNAVAILABLE"));
  expect(row).toBeDefined();
  return row?.message ?? "";
}

describe("ExposureQueue: batch-failure remediation by path (R6)", () => {
  it("timer-armed failure promises the 5s retry", async () => {
    vi.useFakeTimers();
    try {
      const logger = new FakeLogger();
      const queue = new ExposureQueue({
        transport: {
          async redeemExposures() {
            return unavailable();
          },
        },
        logger,
        now: () => Date.parse("2026-08-08T00:00:00.000Z"),
      });
      queue.enqueue("a", "ticket-a");
      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.resolve();
      const message = batchFailureMessage(logger);
      expect(message).toContain(EXPOSURE_BATCH_FAILURE_RETRY_REMEDIATION);
      expect(message).not.toContain(EXPOSURE_BATCH_FAILURE_NO_RETRY_REMEDIATION);
    } finally {
      vi.useRealTimers();
    }
  });

  it("close() failure says the batch will not be retried", async () => {
    const logger = new FakeLogger();
    const queue = new ExposureQueue({
      transport: {
        async redeemExposures() {
          return unavailable();
        },
      },
      logger,
      now: () => Date.parse("2026-08-08T00:00:00.000Z"),
    });
    queue.enqueue("a", "ticket-a");
    await expect(queue.close()).rejects.toThrow(/SERVICE_UNAVAILABLE/);
    const message = batchFailureMessage(logger);
    expect(message).toContain(EXPOSURE_BATCH_FAILURE_NO_RETRY_REMEDIATION);
    expect(message).not.toContain(EXPOSURE_BATCH_FAILURE_RETRY_REMEDIATION);
  });

  it("pagehide failure says the batch will not be retried", async () => {
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
    const logger = new FakeLogger();
    const queue = new ExposureQueue({
      transport: {
        async redeemExposures() {
          return unavailable();
        },
      },
      logger,
      now: () => Date.parse("2026-08-08T00:00:00.000Z"),
      window: fakeWindow,
      document: null,
    });
    queue.enqueue("a", "ticket-a");
    expect(listeners.get("pagehide")?.size).toBe(1);
    for (const handler of listeners.get("pagehide") ?? []) {
      handler();
    }
    await vi.waitFor(() => {
      expect(logger.errors.some((row) => row.message.includes("SERVICE_UNAVAILABLE"))).toBe(true);
    });
    const message = batchFailureMessage(logger);
    expect(message).toContain(EXPOSURE_BATCH_FAILURE_NO_RETRY_REMEDIATION);
    expect(message).not.toContain(EXPOSURE_BATCH_FAILURE_RETRY_REMEDIATION);
  });
});
