import { describe, expect, it, vi } from "vitest";
import type { EvaluateAllEntry } from "../generated/contract-surface.js";
import { FakeLogger } from "../test-fixtures";
import { createSplitchBrowserClient } from "./client";
import { browserOkPayload, FakeBrowserTransport } from "./test-fixtures";

describe("createSplitchBrowserClient: construction", () => {
  it("throws when a secret sk_ key is passed", () => {
    expect(() =>
      createSplitchBrowserClient({ clientKey: "sk_secret", context: { targetingKey: "u1" } }),
    ).toThrow(/SDK_CREDENTIAL_CONFIGURATION_INVALID/);
  });

  it("throws when an ak_ secret is passed", () => {
    expect(() =>
      createSplitchBrowserClient({ clientKey: "ak_secret", context: { targetingKey: "u1" } }),
    ).toThrow(/SDK_CREDENTIAL_CONFIGURATION_INVALID/);
  });

  it("throws when a ck_ Client Key id is passed", () => {
    expect(() =>
      createSplitchBrowserClient({ clientKey: "ck_not_material", context: { targetingKey: "u1" } }),
    ).toThrow(/SDK_CREDENTIAL_CONFIGURATION_INVALID/);
  });

  it("throws SDK_CONTEXT_INVALID for an empty targetingKey", () => {
    expect(() =>
      createSplitchBrowserClient({ clientKey: "pk_test", context: { targetingKey: "" } }),
    ).toThrow(/SDK_CONTEXT_INVALID/);
  });

  it("performs no I/O at construction", () => {
    const transport = new FakeBrowserTransport([browserOkPayload()]);
    createSplitchBrowserClient({
      clientKey: "pk_test",
      context: { targetingKey: "u1" },
      transport,
    });
    expect(transport.evaluateAllCalls).toHaveLength(0);
    expect(transport.redeemCalls).toHaveLength(0);
  });
});

describe("createSplitchBrowserClient: init and sync reads", () => {
  it("after init, reading N flags performs zero further network requests", async () => {
    const transport = new FakeBrowserTransport([browserOkPayload()]);
    const client = createSplitchBrowserClient({
      clientKey: "pk_test",
      context: { targetingKey: "u1" },
      transport,
    });
    await client.init();
    expect(transport.evaluateAllCalls).toHaveLength(1);

    expect(client.evaluate("new-checkout", false)).toBe(true);
    expect(client.evaluate("legacy-banner", true)).toBe(false);
    expect(client.evaluateDetails("new-checkout", false)).toMatchObject({
      value: true,
      variantName: "treatment",
      reason: "SPLIT",
    });
    expect(transport.evaluateAllCalls).toHaveLength(1);
  });

  it("reading before init throws SDK_NOT_INITIALIZED", () => {
    const transport = new FakeBrowserTransport([browserOkPayload()]);
    const client = createSplitchBrowserClient({
      clientKey: "pk_test",
      context: { targetingKey: "u1" },
      transport,
    });
    expect(() => client.evaluate("new-checkout", false)).toThrow(/SDK_NOT_INITIALIZED/);
    expect(() => client.evaluateDetails("new-checkout", false)).toThrow(/SDK_NOT_INITIALIZED/);
  });

  it("unknown flag key returns default with FLAG_NOT_FOUND and logs once", async () => {
    const logger = new FakeLogger();
    const transport = new FakeBrowserTransport([browserOkPayload()]);
    const client = createSplitchBrowserClient({
      clientKey: "pk_test",
      context: { targetingKey: "u1" },
      transport,
      logger,
    });
    await client.init();

    expect(client.evaluate("missing-flag", "fallback")).toBe("fallback");
    expect(client.evaluate("missing-flag", "fallback")).toBe("fallback");
    expect(client.evaluateDetails("missing-flag", "fallback")).toMatchObject({
      value: "fallback",
      reason: "ERROR",
      errorCode: "FLAG_NOT_FOUND",
    });
    expect(logger.errors.filter((row) => row.message.includes("FLAG_NOT_FOUND"))).toHaveLength(1);
  });

  it("held ERROR entry returns default with the entry errorCode", async () => {
    const logger = new FakeLogger();
    const transport = new FakeBrowserTransport([browserOkPayload()]);
    const client = createSplitchBrowserClient({
      clientKey: "pk_test",
      context: { targetingKey: "u1" },
      transport,
      logger,
    });
    await client.init();

    expect(client.evaluateDetails("broken-flag", false)).toMatchObject({
      value: false,
      reason: "ERROR",
      errorCode: "SERVICE_UNAVAILABLE",
    });
  });

  it("null variant returns DEFAULT without enqueuing an Exposure", async () => {
    const logger = new FakeLogger();
    const evaluations: Record<string, EvaluateAllEntry> = {
      "renamed-arm": {
        variant: null,
        variantName: "treatment",
        reason: "SPLIT",
        errorCode: null,
        exposureTicket: "ticket-should-not-fire",
      },
    };
    const transport = new FakeBrowserTransport([browserOkPayload(evaluations)]);
    const client = createSplitchBrowserClient({
      clientKey: "pk_test",
      context: { targetingKey: "u1" },
      transport,
      logger,
    });
    await client.init();

    expect(client.evaluateDetails("renamed-arm", false)).toMatchObject({
      value: false,
      variantName: null,
      reason: "DEFAULT",
    });
    await client.flush();
    expect(transport.redeemCalls).toHaveLength(0);
    expect(logger.errors.length).toBeGreaterThan(0);
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

  it("subscribe accepts absent keys and does not enqueue an Exposure", async () => {
    const transport = new FakeBrowserTransport([browserOkPayload()]);
    const client = createSplitchBrowserClient({
      clientKey: "pk_test",
      context: { targetingKey: "u1" },
      transport,
    });
    await client.init();
    const stop = client.subscribe("not-yet-present", () => undefined);
    expect(transport.redeemCalls).toHaveLength(0);
    stop();
  });

  it("flush resolves with per-item ExposureBatchResult rows", async () => {
    const exposureId = "11111111-1111-4111-8111-111111111111";
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(exposureId);
    const transport = new FakeBrowserTransport([browserOkPayload()]);
    const client = createSplitchBrowserClient({
      clientKey: "pk_test",
      context: { targetingKey: "u1" },
      transport,
    });
    await client.init();
    client.evaluate("new-checkout", false);
    const results = await client.flush();
    expect(results).toEqual([{ exposureId, status: "accepted", code: null }]);
    vi.restoreAllMocks();
  });
});
