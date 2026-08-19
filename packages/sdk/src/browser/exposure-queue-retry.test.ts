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

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ExposureQueue: bounded automatic retries", () => {
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

describe("ExposureQueue: per-item retry accounting", () => {
  it("retains and redelivers a retryable per-item rejection without sibling resets", async () => {
    const logger = new FakeLogger();
    const redeemCalls: string[][] = [];
    let retryId: string | undefined;
    let calls = 0;
    const queue = new ExposureQueue({
      transport: {
        async redeemExposures(exposures) {
          calls += 1;
          redeemCalls.push(exposures.map((item) => item.exposureId));
          if (calls === 4) {
            return acceptAll(exposures);
          }
          retryId ??= exposures[1]?.exposureId;
          return {
            status: 202,
            results: exposures.map((item) =>
              item.exposureId === retryId
                ? {
                    exposureId: item.exposureId,
                    status: "rejected" as const,
                    code: "SERVICE_UNAVAILABLE" as const,
                  }
                : { exposureId: item.exposureId, status: "accepted" as const, code: null },
            ),
          };
        },
      },
      logger,
      now: () => Date.parse("2026-08-08T00:00:00.000Z"),
    });

    queue.enqueue("accepted-0", "ticket-accepted-0");
    queue.enqueue("retry", "ticket-retry");
    await expect(queue.flush()).resolves.toHaveLength(2);
    queue.enqueue("accepted-1", "ticket-accepted-1");
    await expect(queue.flush()).resolves.toHaveLength(2);
    queue.enqueue("accepted-2", "ticket-accepted-2");
    await expect(queue.flush()).resolves.toHaveLength(2);

    expect(redeemCalls).toHaveLength(3);
    expect(redeemCalls.every((ids) => ids.includes(retryId ?? "missing"))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(logger.errors.some((row) => row.detail.attemptCount === 3)).toBe(true);

    await expect(queue.flush()).resolves.toHaveLength(1);
    expect(redeemCalls[3]).toEqual([retryId]);
  });

  it("counts all retained items when omitted and retryable results are mixed", async () => {
    const logger = new FakeLogger();
    const redeemCalls: string[][] = [];
    let omittedId: string | undefined;
    const retryIds = new Set<string>();
    const queue = new ExposureQueue({
      transport: {
        async redeemExposures(exposures) {
          redeemCalls.push(exposures.map((item) => item.exposureId));
          omittedId ??= exposures[0]?.exposureId;
          if (retryIds.size === 0) {
            retryIds.add(exposures[1]?.exposureId ?? "missing-retry-1");
            retryIds.add(exposures[2]?.exposureId ?? "missing-retry-2");
          }
          return {
            status: 202,
            results: exposures
              .filter((item) => item.exposureId !== omittedId)
              .map((item) => ({
                exposureId: item.exposureId,
                status: retryIds.has(item.exposureId)
                  ? ("rejected" as const)
                  : ("accepted" as const),
                code: retryIds.has(item.exposureId) ? ("SERVICE_UNAVAILABLE" as const) : null,
              })),
          };
        },
      },
      logger,
      now: () => Date.parse("2026-08-08T00:00:00.000Z"),
    });

    queue.enqueue("omitted", "ticket-omitted");
    queue.enqueue("retry-1", "ticket-retry-1");
    queue.enqueue("retry-2", "ticket-retry-2");
    queue.enqueue("accepted-0", "ticket-accepted-0");
    await expect(queue.flush()).resolves.toHaveLength(3);
    queue.enqueue("accepted-1", "ticket-accepted-1");
    await expect(queue.flush()).resolves.toHaveLength(3);
    queue.enqueue("accepted-2", "ticket-accepted-2");
    await expect(queue.flush()).resolves.toHaveLength(3);

    expect(redeemCalls).toHaveLength(3);
    expect(redeemCalls.every((ids) => ids.includes(omittedId ?? "missing"))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(
      logger.errors.some((row) => row.detail.attemptCount === 3 && row.detail.count === 3),
    ).toBe(true);
    expect(logger.errors.filter((row) => row.detail.unmatchedCount === 1)).toHaveLength(3);
  });
});

describe("ExposureQueue: invalid per-item results", () => {
  it.each([
    {
      label: "unknown result status",
      status: "future-status",
      code: null,
      expected: /Unrecognized Exposure batch result status/,
    },
    {
      label: "rejected result without a code",
      status: "rejected",
      code: null,
      expected: /missing a code/,
    },
  ])("fails loud and retains the batch for $label", async ({ status, code, expected }) => {
    const redeemCalls: string[][] = [];
    const queue = new ExposureQueue({
      transport: {
        async redeemExposures(exposures) {
          redeemCalls.push(exposures.map((item) => item.exposureId));
          const item = exposures[0];
          if (item === undefined) {
            throw new Error("expected one Exposure");
          }
          return {
            status: 202,
            results: [{ exposureId: item.exposureId, status, code }],
          } as unknown as BrowserExposuresResult;
        },
      },
      logger: new FakeLogger(),
      now: () => Date.parse("2026-08-08T00:00:00.000Z"),
    });

    queue.enqueue("flag", "ticket");
    const thrown = await queue.flush().catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(expected);
    expect((thrown as Error).cause).toBeInstanceOf(Error);
    expect(((thrown as Error).cause as Error).message).toMatch(expected);
    await expect(queue.flush()).rejects.toThrow(expected);
    expect(redeemCalls).toHaveLength(2);
    expect(redeemCalls[1]).toEqual(redeemCalls[0]);
  });
});
