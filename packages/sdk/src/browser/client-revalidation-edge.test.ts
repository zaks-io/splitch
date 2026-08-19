import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrecomputedEvaluations } from "../evaluate-all";
import type { EvaluateAllEntry, VariantValue } from "../generated/contract-surface.js";
import { FakeLogger } from "../test-fixtures";
import { createSplitchBrowserClient } from "./client";
import { getBrowserClientInternalAccess } from "./client-internals";
import { FakeBrowserTransport } from "./test-fixtures";
import type { BrowserEvaluateAllResult, BrowserTransport } from "./transport";

const CONTEXT = { targetingKey: "u1", idType: "user", attributes: {} } as const;

function entry(variant: VariantValue): EvaluateAllEntry {
  return {
    variant,
    variantName: "on",
    reason: "SPLIT",
    errorCode: null,
    exposureIdentity: null,
    exposureTicket: null,
  };
}

function bootstrap(evaluations: Record<string, EvaluateAllEntry>): PrecomputedEvaluations {
  return { context: CONTEXT, evaluations, etag: '"etag-1"' };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly reject: (cause: unknown) => void;
} {
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  return { promise, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("createSplitchBrowserClient: revalidation edges", () => {
  it("ignores an in-flight transport rejection after close", async () => {
    const gate = deferred<BrowserEvaluateAllResult>();
    const logger = new FakeLogger();
    const transport: BrowserTransport = {
      evaluateAll: vi.fn(() => gate.promise),
      redeemExposures: vi.fn(async () => ({ status: 202, results: [] })),
    };
    const client = createSplitchBrowserClient({
      clientKey: "pk_test",
      context: { targetingKey: "u1" },
      bootstrap: bootstrap({ checkout: entry(true) }),
      revalidateMs: 1_000,
      transport,
      logger,
    });
    const internal = getBrowserClientInternalAccess(client);

    await vi.advanceTimersByTimeAsync(1_000);
    await client.close();
    gate.reject(new Error("aborted during close"));
    await Promise.resolve();
    await Promise.resolve();

    expect(logger.errors).toHaveLength(0);
    expect(internal.readRevalidationDegraded()).toBe(false);
    expect(client.evaluateDetails("checkout", false)).toMatchObject({ reason: "SPLIT" });
  });

  it("recovers on 304 without swapping or notifying", async () => {
    const variant = { enabled: true };
    const transport = new FakeBrowserTransport([
      {
        status: 503,
        evaluations: null,
        etag: null,
        errorCode: "SERVICE_UNAVAILABLE",
      },
      { status: 304, evaluations: null, etag: null },
    ]);
    const client = createSplitchBrowserClient({
      clientKey: "pk_test",
      context: { targetingKey: "u1" },
      bootstrap: bootstrap({ checkout: entry(variant) }),
      revalidateMs: 1_000,
      transport,
      logger: new FakeLogger(),
    });
    const listener = vi.fn();
    client.subscribe("checkout", listener);
    const heldVariant = client.evaluate("checkout", false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.evaluateDetails("checkout", false)).toMatchObject({ reason: "STALE" });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.evaluateDetails("checkout", false)).toMatchObject({ reason: "SPLIT" });
    expect(client.evaluate("checkout", false)).toBe(heldVariant);
    expect(listener).not.toHaveBeenCalled();
    expect(transport.evaluateAllCalls).toHaveLength(2);
    expect(transport.evaluateAllCalls[1]).toMatchObject({ ifNoneMatch: '"etag-1"' });
    await client.close();
  });
});
