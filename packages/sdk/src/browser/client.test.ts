import { afterEach, describe, expect, it } from "vitest";
import { SplitchSdkError } from "../errors";
import { FakeLogger } from "../test-fixtures";
import { createSplitchBrowserClient } from "./client";
import { BROWSER_EVALUATIONS, browserOkPayload, FakeBrowserTransport } from "./test-fixtures";

describe("createSplitchBrowserClient: construction", () => {
  it("throws when a secret sk_ key is passed", () => {
    expect(() =>
      createSplitchBrowserClient({ clientKey: "sk_secret", context: { targetingKey: "u1" } }),
    ).toThrow(SplitchSdkError);
    try {
      createSplitchBrowserClient({ clientKey: "sk_secret", context: { targetingKey: "u1" } });
    } catch (error) {
      expect(error).toMatchObject({ code: "SDK_CREDENTIAL_CONFIGURATION_INVALID" });
    }
  });

  it("throws when an ak_ secret is passed", () => {
    expect(() =>
      createSplitchBrowserClient({ clientKey: "ak_secret", context: { targetingKey: "u1" } }),
    ).toThrow(/SDK_CREDENTIAL_CONFIGURATION_INVALID/);
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
  afterEach(() => {
    // Keep timer hygiene if a sibling suite enables fake timers later.
  });

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
    expect(Object.keys(BROWSER_EVALUATIONS).length).toBeGreaterThan(1);
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

  it("unknown flag key returns default with FLAG_NOT_FOUND and logs loud", async () => {
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
    expect(client.evaluateDetails("missing-flag", "fallback")).toMatchObject({
      value: "fallback",
      reason: "ERROR",
      errorCode: "FLAG_NOT_FOUND",
    });
    expect(logger.errors.length).toBeGreaterThan(0);
    expect(logger.errors[0]?.message).toContain("FLAG_NOT_FOUND");
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
});
