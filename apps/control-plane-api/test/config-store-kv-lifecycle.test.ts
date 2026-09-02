import { controlPlaneFlagConfigKey } from "@splitch/contracts";
import { envScope } from "@splitch/db";
import { describe, expect, it, vi } from "vitest";
import { deleteFlagConfigSnapshot } from "../src/config-store-kv";

describe("control-plane Flag Configuration snapshot lifecycle", () => {
  it("expires deletion tombstones after the accepted KV propagation window", async () => {
    const put = vi.fn(() => Promise.resolve());
    const kv = {
      delete: vi.fn(() => Promise.resolve()),
      get: vi.fn(() => Promise.resolve(null)),
      put,
    } as unknown as KVNamespace;

    await deleteFlagConfigSnapshot(
      kv,
      envScope("app_1", "env_1"),
      "flag_1",
      2,
      "checkout",
      [],
      false,
    );

    expect(put).toHaveBeenCalledWith(
      controlPlaneFlagConfigKey("app_1", "env_1", "flag_1"),
      expect.stringContaining('"state":"deleted"'),
      { expirationTtl: 62 },
    );
  });
});
