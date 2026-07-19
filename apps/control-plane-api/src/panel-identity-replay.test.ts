import { describe, expect, it, vi } from "vitest";
import { makePanelIdentityReplayStore } from "./panel-identity-replay";

describe("Control Panel identity replay store", () => {
  it("accepts a nonce once and rejects sequential replay", async () => {
    const values = new Map<string, string>();
    const kv = {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
    } as unknown as KVNamespace;
    const replay = makePanelIdentityReplayStore(kv);

    await expect(replay.consume("nonce_1234567890abcdef", 130, 100)).resolves.toBe(true);
    await expect(replay.consume("nonce_1234567890abcdef", 130, 100)).resolves.toBe(false);
    expect(kv.put).toHaveBeenCalledWith("control-panel-identity:nonce_1234567890abcdef", "used", {
      expirationTtl: 60,
    });
  });

  it("rejects an already expired identity without writing it", async () => {
    const kv = { get: vi.fn(), put: vi.fn() } as unknown as KVNamespace;
    await expect(makePanelIdentityReplayStore(kv).consume("nonce", 100, 100)).resolves.toBe(false);
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });
});
