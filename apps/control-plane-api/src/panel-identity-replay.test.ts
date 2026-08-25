import { describe, expect, it, vi } from "vitest";
import { makePanelDelegationReplayStore, replayShardName } from "./panel-identity-replay";

describe("Control Panel delegation replay store", () => {
  it("routes every redemption for one nonce to the same shard, carrying the nonce", async () => {
    const consume = vi.fn(async () => true);
    const getByName = vi.fn(() => ({ consume }));
    const replay = makePanelDelegationReplayStore({ getByName });

    await expect(replay.consume("nonce_1234567890abcdef", 130, 100)).resolves.toBe(true);
    expect(getByName).toHaveBeenCalledWith(replayShardName("nonce_1234567890abcdef"));
    expect(consume).toHaveBeenCalledWith("nonce_1234567890abcdef", 130, 100);
  });

  it("maps a nonce to a stable shard drawn from the bounded shard set", () => {
    const name = replayShardName("nonce_1234567890abcdef");
    expect(name).toBe(replayShardName("nonce_1234567890abcdef"));
    expect(name).toMatch(/^replay-shard-\d+$/);
  });

  it("spreads distinct nonces across more than one shard", () => {
    const shards = new Set(
      Array.from({ length: 64 }, (_, index) => replayShardName(`nonce_${index}_abcdefghij`)),
    );
    expect(shards.size).toBeGreaterThan(1);
  });
});
