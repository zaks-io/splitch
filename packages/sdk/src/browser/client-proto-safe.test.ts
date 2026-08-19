import { describe, expect, it } from "vitest";
import { FakeLogger } from "../test-fixtures";
import { createSplitchBrowserClient } from "./client";
import { browserOkPayload, FakeBrowserTransport } from "./test-fixtures";

describe("createSplitchBrowserClient: prototype-colliding Flag Keys", () => {
  it("treats inherited Object.prototype members as missing without queueing Exposures", async () => {
    const logger = new FakeLogger();
    const transport = new FakeBrowserTransport([browserOkPayload()]);
    const client = createSplitchBrowserClient({
      clientKey: "pk_test",
      context: { targetingKey: "u1" },
      transport,
      logger,
    });
    await client.init();

    expect(client.evaluate("toString", "fallback")).toBe("fallback");
    expect(client.evaluateDetails("toString", "fallback")).toMatchObject({
      value: "fallback",
      reason: "ERROR",
      errorCode: "FLAG_NOT_FOUND",
    });
    expect(client.evaluate("constructor", true)).toBe(true);
    expect(client.evaluateDetails("constructor", true)).toMatchObject({
      value: true,
      reason: "ERROR",
      errorCode: "FLAG_NOT_FOUND",
    });

    await expect(client.flush()).resolves.toEqual([]);
    expect(transport.redeemCalls).toHaveLength(0);
    expect(logger.errors.map((row) => row.detail.flagKey)).toEqual(["toString", "constructor"]);
  });
});
