import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("PanelDelegationReplayDurableObject", () => {
  it("atomically consumes a nonce once and remains reusable after cleanup", async () => {
    const stub = env.PANEL_DELEGATION_REPLAY.getByName("nonce_concurrent_1234567890");
    const nowSeconds = Math.floor(Date.now() / 1_000);

    await expect(
      Promise.all([
        stub.consume(nowSeconds + 30, nowSeconds),
        stub.consume(nowSeconds + 30, nowSeconds),
      ]),
    ).resolves.toEqual(expect.arrayContaining([true, false]));

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await expect(stub.consume(nowSeconds + 60, nowSeconds + 30)).resolves.toBe(true);
  });

  it("does not consume an expired delegation", async () => {
    const stub = env.PANEL_DELEGATION_REPLAY.getByName("nonce_expired_1234567890");

    await expect(stub.consume(100, 100)).resolves.toBe(false);
  });
});
