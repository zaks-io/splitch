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

  it("throws when clientKey is empty (M04)", () => {
    expect(() =>
      createSplitchBrowserClient({ clientKey: "", context: { targetingKey: "u1" } }),
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

  it("default fetch is not invoked as a method on a foreign receiver (M01)", async () => {
    let callThis: unknown = "unset";
    const stubFetch = function fetchStub(
      this: unknown,
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> {
      callThis = this;
      if (this !== undefined && this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            evaluations: {
              flag: {
                variant: true,
                variantName: "on",
                reason: "SPLIT",
                errorCode: null,
                exposureTicket: null,
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json", etag: '"e"' } },
        ),
      );
    };
    const original = globalThis.fetch;
    globalThis.fetch = stubFetch as unknown as typeof fetch;
    try {
      const client = createSplitchBrowserClient({
        clientKey: "pk_test",
        context: { targetingKey: "u1" },
        endpoint: "https://edge.test",
      });
      await client.init();
      expect(callThis).toBe(globalThis);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("createSplitchBrowserClient: sync reads", () => {
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

  it("reading before init throws SDK_NOT_INITIALIZED without mentioning bootstrap", () => {
    const transport = new FakeBrowserTransport([browserOkPayload()]);
    const client = createSplitchBrowserClient({
      clientKey: "pk_test",
      context: { targetingKey: "u1" },
      transport,
    });
    expect(() => client.evaluate("new-checkout", false)).toThrow(/SDK_NOT_INITIALIZED/);
    try {
      client.evaluate("new-checkout", false);
    } catch (error) {
      expect(String(error)).not.toMatch(/bootstrap/i);
    }
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
      "renamed-variant": {
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

    expect(client.evaluateDetails("renamed-variant", false)).toMatchObject({
      value: false,
      variantName: null,
      reason: "DEFAULT",
    });
    await client.flush();
    expect(transport.redeemCalls).toHaveLength(0);
    expect(logger.errors.length).toBeGreaterThan(0);
    expect(logger.errors.some((row) => row.message.includes("Variants"))).toBe(true);
    expect(logger.errors.some((row) => /\barms\b/i.test(row.message))).toBe(false);
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
