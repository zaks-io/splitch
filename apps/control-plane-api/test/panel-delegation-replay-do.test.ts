import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("PanelDelegationReplayDurableObject", () => {
  it("atomically consumes a nonce once and remains reusable after alarm cleanup", async () => {
    const stub = env.PANEL_DELEGATION_REPLAY.getByName("shard_concurrent_1234567890");
    // A window entirely in the wall-clock past: the alarm's Date.now() sweep sees
    // the row as expired, while every consume's own sweep (bounded by nowSeconds)
    // cannot remove it. A post-alarm redemption therefore proves the alarm ran.
    const nowSeconds = Math.floor(Date.now() / 1_000) - 100;

    await expect(
      Promise.all([
        stub.consume("nonce_concurrent_abcdef", nowSeconds + 30, nowSeconds),
        stub.consume("nonce_concurrent_abcdef", nowSeconds + 30, nowSeconds),
      ]),
    ).resolves.toEqual(expect.arrayContaining([true, false]));

    // The redemption's alarm is already due, so workerd may have auto-fired it;
    // this flushes it if it is still pending. Either way it has run afterwards.
    await runDurableObjectAlarm(stub);
    await expect(
      stub.consume("nonce_concurrent_abcdef", nowSeconds + 40, nowSeconds),
    ).resolves.toBe(true);
  });

  it("consumes distinct nonces on one shard independently", async () => {
    const stub = env.PANEL_DELEGATION_REPLAY.getByName("shard_distinct_1234567890");
    const nowSeconds = Math.floor(Date.now() / 1_000);

    await expect(stub.consume("nonce_first_abcdefghij", nowSeconds + 30, nowSeconds)).resolves.toBe(
      true,
    );
    await expect(stub.consume("nonce_second_abcdefghi", nowSeconds + 30, nowSeconds)).resolves.toBe(
      true,
    );
    await expect(stub.consume("nonce_first_abcdefghij", nowSeconds + 30, nowSeconds)).resolves.toBe(
      false,
    );
  });

  it("frees a redeemed nonce for reuse only after its expiry has passed", async () => {
    const stub = env.PANEL_DELEGATION_REPLAY.getByName("shard_expiry_1234567890");
    const nowSeconds = Math.floor(Date.now() / 1_000);

    await expect(stub.consume("nonce_expiring_abcdefg", nowSeconds + 30, nowSeconds)).resolves.toBe(
      true,
    );
    // Still live: a later consume within the window is a replay.
    await expect(
      stub.consume("nonce_expiring_abcdefg", nowSeconds + 40, nowSeconds + 10),
    ).resolves.toBe(false);
    // After expiry the sweep-on-consume clears the row, so the nonce is free again.
    await expect(
      stub.consume("nonce_expiring_abcdefg", nowSeconds + 90, nowSeconds + 60),
    ).resolves.toBe(true);
  });

  it("does not consume an expired delegation", async () => {
    const stub = env.PANEL_DELEGATION_REPLAY.getByName("shard_expired_1234567890");

    await expect(stub.consume("nonce_expired_abcdefghi", 100, 100)).resolves.toBe(false);
  });
});
