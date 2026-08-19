import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrecomputedEvaluations } from "../evaluate-all";
import type { EvaluateAllEntry } from "../generated/contract-surface.js";
import { FakeLogger } from "../test-fixtures";
import { createSplitchBrowserClient } from "./client";
import { decorateHeldDetails, getBrowserClientInternalAccess } from "./client-internals";
import { FakeBrowserTransport } from "./test-fixtures";

const CONTEXT = { targetingKey: "u1", idType: "user", attributes: {} } as const;

function entry(
  variant: boolean,
  exposureIdentity: string | null = null,
  exposureTicket: string | null = null,
): EvaluateAllEntry {
  return {
    variant,
    variantName: variant ? "on" : "off",
    reason: "SPLIT",
    errorCode: null,
    exposureIdentity,
    exposureTicket,
  };
}

function bootstrap(
  evaluations: Record<string, EvaluateAllEntry>,
  etag = '"etag-1"',
): PrecomputedEvaluations {
  return { context: CONTEXT, evaluations, etag };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("createSplitchBrowserClient: bootstrap", () => {
  it("hydrates synchronously with zero transport calls before the first tick", async () => {
    const transport = new FakeBrowserTransport([{ status: 304, evaluations: null, etag: null }]);
    const client = createSplitchBrowserClient({
      clientKey: "pk_test",
      context: { targetingKey: "u1" },
      bootstrap: bootstrap({ checkout: entry(true), banner: entry(false) }),
      revalidateMs: 1_000,
      transport,
    });

    expect(client.evaluate("checkout", false)).toBe(true);
    expect(client.evaluate("banner", true)).toBe(false);
    await client.init();
    expect(transport.evaluateAllCalls).toHaveLength(0);
    expect(transport.redeemCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(transport.evaluateAllCalls).toHaveLength(1);
    expect(transport.evaluateAllCalls[0]).toMatchObject({ ifNoneMatch: '"etag-1"' });
    await client.close();
  });

  it("detaches nested context attributes before later revalidation", async () => {
    const cohort = { name: "beta" };
    const transport = new FakeBrowserTransport([{ status: 304, evaluations: null, etag: null }]);
    const client = createSplitchBrowserClient({
      clientKey: "pk_test",
      context: { targetingKey: "u1", attributes: { cohorts: [cohort] } },
      bootstrap: {
        context: {
          targetingKey: "u1",
          idType: "user",
          attributes: { cohorts: [{ name: "beta" }] },
        },
        evaluations: { checkout: entry(true) },
        etag: '"etag-1"',
      },
      revalidateMs: 1_000,
      transport,
    });
    cohort.name = "internal";

    await vi.advanceTimersByTimeAsync(1_000);

    expect(transport.evaluateAllCalls[0]).toMatchObject({
      attributes: { cohorts: [{ name: "beta" }] },
    });
    await client.close();
  });

  it("throws the typed context-mismatch error during construction", () => {
    expect(() =>
      createSplitchBrowserClient({
        clientKey: "pk_test",
        context: { targetingKey: "u1", attributes: { plan: "pro" } },
        bootstrap: {
          context: { targetingKey: "u2", idType: "user", attributes: { plan: "pro" } },
          evaluations: { checkout: entry(true) },
          etag: '"etag-1"',
        },
        transport: new FakeBrowserTransport([]),
      }),
    ).toThrowError(expect.objectContaining({ code: "SDK_BOOTSTRAP_CONTEXT_MISMATCH" }));
  });

  it("swaps atomically and emits only the changed Flag's event", async () => {
    const logger = new FakeLogger();
    const transport = new FakeBrowserTransport([
      {
        status: 200,
        evaluations: { checkout: entry(false), banner: entry(false) },
        etag: '"etag-2"',
      },
    ]);
    const client = createSplitchBrowserClient({
      clientKey: "pk_test",
      context: { targetingKey: "u1" },
      bootstrap: bootstrap({ checkout: entry(true), banner: entry(false) }),
      revalidateMs: 1_000,
      transport,
      logger,
    });
    const checkoutChanged = vi.fn();
    const bannerChanged = vi.fn();
    client.subscribe("checkout", () => {
      throw new Error("subscriber failed");
    });
    client.subscribe("checkout", checkoutChanged);
    client.subscribe("banner", bannerChanged);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(client.evaluate("checkout", true)).toBe(false);
    expect(client.evaluate("banner", true)).toBe(false);
    expect(checkoutChanged).toHaveBeenCalledTimes(1);
    expect(bannerChanged).not.toHaveBeenCalled();
    expect(logger.errors).toHaveLength(1);
    await client.close();
  });
});

describe("createSplitchBrowserClient: ETag revalidation", () => {
  it("logs every failed tick, serves last-known-good as stale, and recovers", async () => {
    const logger = new FakeLogger();
    const failure = {
      status: null,
      evaluations: null,
      etag: null,
      errorCode: "SDK_TRANSPORT_NETWORK" as const,
      errorMessage: "network down",
    };
    const transport = new FakeBrowserTransport([
      failure,
      failure,
      { status: 200, evaluations: { checkout: entry(false) }, etag: '"etag-2"' },
    ]);
    const client = createSplitchBrowserClient({
      clientKey: "pk_test",
      context: { targetingKey: "u1" },
      bootstrap: bootstrap({ checkout: entry(true) }),
      revalidateMs: 1_000,
      transport,
      logger,
    });
    const internal = getBrowserClientInternalAccess(client);

    expect(internal.decorateHeldDetails).toBe(decorateHeldDetails);
    expect(internal.readRevalidationDegraded()).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(internal.readRevalidationDegraded()).toBe(true);
    expect(logger.errors).toHaveLength(1);
    expect(client.evaluateDetails("checkout", false)).toMatchObject({
      value: true,
      reason: "STALE",
      errorCode: "PROVIDER_NOT_READY",
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(internal.readRevalidationDegraded()).toBe(true);
    expect(logger.errors).toHaveLength(2);
    expect(client.evaluate("checkout", false)).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(internal.readRevalidationDegraded()).toBe(false);
    expect(client.evaluateDetails("checkout", true)).toMatchObject({
      value: false,
      reason: "SPLIT",
    });
    expect(logger.errors).toHaveLength(2);
    await client.close();
  });

  it("does not overwrite higher-precedence details while degraded", async () => {
    const transport = new FakeBrowserTransport([
      {
        status: null,
        evaluations: null,
        etag: null,
        errorCode: "SDK_TRANSPORT_NETWORK",
        errorMessage: "network down",
      },
    ]);
    const client = createSplitchBrowserClient({
      clientKey: "pk_test",
      context: { targetingKey: "u1" },
      bootstrap: bootstrap({
        checkout: entry(true),
        broken: {
          ...entry(false),
          reason: "ERROR",
          errorCode: "SERVICE_UNAVAILABLE",
        },
        empty: { ...entry(false), variant: null },
      }),
      revalidateMs: 1_000,
      transport,
      logger: new FakeLogger(),
    });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(client.evaluateDetails("checkout", false)).toMatchObject({ reason: "STALE" });
    expect(client.evaluateDetails("broken", true)).toMatchObject({
      reason: "ERROR",
      errorCode: "SERVICE_UNAVAILABLE",
    });
    expect(client.evaluateDetails("empty", true)).toMatchObject({ reason: "DEFAULT" });
    expect(client.evaluateDetails("missing", true)).toMatchObject({
      reason: "ERROR",
      errorCode: "FLAG_NOT_FOUND",
    });
    await client.close();
  });

  it("re-arms a changed resolution with the new server-issued ticket", async () => {
    const transport = new FakeBrowserTransport([
      {
        status: 200,
        evaluations: { checkout: entry(true, "binding-2", "ticket-2") },
        etag: '"etag-2"',
      },
    ]);
    const client = createSplitchBrowserClient({
      clientKey: "pk_test",
      context: { targetingKey: "u1" },
      bootstrap: bootstrap({ checkout: entry(true, "binding-1", "ticket-1") }),
      revalidateMs: 1_000,
      transport,
    });

    client.evaluate("checkout", false);
    await client.flush();
    await vi.advanceTimersByTimeAsync(1_000);
    client.evaluate("checkout", false);
    await client.flush();

    expect(transport.redeemCalls.map((call) => call.exposures[0]?.exposureTicket)).toEqual([
      "ticket-1",
      "ticket-2",
    ]);
    await client.close();
  });

  it("close stops the loop and revalidateMs zero never starts it", async () => {
    const stoppedTransport = new FakeBrowserTransport([
      { status: 304, evaluations: null, etag: null },
    ]);
    const stopped = createSplitchBrowserClient({
      clientKey: "pk_test",
      context: { targetingKey: "u1" },
      bootstrap: bootstrap({ checkout: entry(true) }),
      revalidateMs: 1_000,
      transport: stoppedTransport,
    });
    await stopped.close();

    const disabledTransport = new FakeBrowserTransport([]);
    const disabled = createSplitchBrowserClient({
      clientKey: "pk_test",
      context: { targetingKey: "u1" },
      bootstrap: bootstrap({ checkout: entry(true) }),
      revalidateMs: 0,
      transport: disabledTransport,
    });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(stoppedTransport.evaluateAllCalls).toHaveLength(0);
    expect(disabledTransport.evaluateAllCalls).toHaveLength(0);
    await disabled.close();
  });
});
