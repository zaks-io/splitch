import { describe, expect, it, vi } from "vitest";
import { makePanelDelegationReplayStore } from "./panel-identity-replay";

describe("Control Panel delegation replay store", () => {
  it("routes every redemption for one nonce to the same Durable Object", async () => {
    const consume = vi.fn(async () => true);
    const getByName = vi.fn(() => ({ consume }));
    const replay = makePanelDelegationReplayStore({ getByName });

    await expect(replay.consume("nonce_1234567890abcdef", 130, 100)).resolves.toBe(true);
    expect(getByName).toHaveBeenCalledWith("nonce_1234567890abcdef");
    expect(consume).toHaveBeenCalledWith(130, 100);
  });
});
