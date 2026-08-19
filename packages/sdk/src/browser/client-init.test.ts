import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeLogger } from "../test-fixtures";
import { createSplitchBrowserClient } from "./client";
import { browserOkPayload, FakeBrowserTransport } from "./test-fixtures";

describe("createSplitchBrowserClient: init failure surface (B4)", () => {
  it("init rejects on non-200 status (M07)", async () => {
    const transport = new FakeBrowserTransport([
      { status: 401, evaluations: null, etag: null, errorCode: "UNAUTHORIZED" },
    ]);
    const client = createSplitchBrowserClient({
      clientKey: "pk_test",
      context: { targetingKey: "u1" },
      transport,
    });
    await expect(client.init()).rejects.toThrow();
    expect(() => client.evaluate("new-checkout", false)).toThrow(/SDK_NOT_INITIALIZED/);
  });

  it("init rejects a 201 with a valid payload (status clause, M07)", async () => {
    const transport = new FakeBrowserTransport([
      {
        status: 201,
        evaluations: {
          flag: {
            variant: true,
            variantName: "on",
            reason: "SPLIT",
            errorCode: null,
            exposureTicket: null,
            exposureIdentity: null,
          },
        },
        etag: '"e"',
      },
    ]);
    const client = createSplitchBrowserClient({
      clientKey: "pk_test",
      context: { targetingKey: "u1" },
      transport,
    });
    await expect(client.init()).rejects.toThrow();
    expect(() => client.evaluate("flag", false)).toThrow(/SDK_NOT_INITIALIZED/);
  });

  it("init rejects when evaluations are null despite 200 (M07)", async () => {
    const transport = new FakeBrowserTransport([{ status: 200, evaluations: null, etag: '"e"' }]);
    const client = createSplitchBrowserClient({
      clientKey: "pk_test",
      context: { targetingKey: "u1" },
      transport,
    });
    await expect(client.init()).rejects.toThrow();
  });

  it("init rejects when etag is null (M08)", async () => {
    const transport = new FakeBrowserTransport([
      { status: 200, evaluations: {}, etag: null, errorCode: "SDK_TRANSPORT_PARSE" },
    ]);
    const client = createSplitchBrowserClient({
      clientKey: "pk_test",
      context: { targetingKey: "u1" },
      transport,
    });
    await expect(client.init()).rejects.toThrow();
  });

  it("init is idempotent after success", async () => {
    const transport = new FakeBrowserTransport([browserOkPayload()]);
    const client = createSplitchBrowserClient({
      clientKey: "pk_test",
      context: { targetingKey: "u1" },
      transport,
    });
    await client.init();
    await client.init();
    expect(transport.evaluateAllCalls).toHaveLength(1);
  });

  it("init throws when crypto.randomUUID is unavailable (M16)", async () => {
    const original = globalThis.crypto.randomUUID;
    // @ts-expect-error intentional mutation probe
    globalThis.crypto.randomUUID = undefined;
    const transport = new FakeBrowserTransport([browserOkPayload()]);
    const client = createSplitchBrowserClient({
      clientKey: "pk_test",
      context: { targetingKey: "u1" },
      transport,
      logger: new FakeLogger(),
    });
    await expect(client.init()).rejects.toThrow(/SDK_IDEMPOTENCY_KEY_UNAVAILABLE/);
    globalThis.crypto.randomUUID = original;
  });
});

describe("createSplitchBrowserClient: timer auto-flush (M39)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("auto-flushes pending Exposures after FLUSH_DELAY_MS", async () => {
    const transport = new FakeBrowserTransport([browserOkPayload()]);
    const client = createSplitchBrowserClient({
      clientKey: "pk_test",
      context: { targetingKey: "u1" },
      transport,
      now: () => Date.parse("2026-08-08T00:00:00.000Z"),
    });
    await client.init();
    client.evaluate("new-checkout", false);
    expect(transport.redeemCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(transport.redeemCalls.length).toBeGreaterThan(0);
  });
});
