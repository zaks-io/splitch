import { flagConfigKey } from "@splitch/contracts";
import { envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, ids } from "../src/config-store-harness-core";
import { deleteFlagConfigSnapshot } from "../src/config-store-kv";
import { makePoolHarness } from "./config-store-pool-harness";

let h: Harness;

beforeEach(async () => {
  h = await makePoolHarness();
});

afterEach(async () => {
  await h.dispose();
});

describe("Flag Configuration delete ownership guard", () => {
  it("fails loud without deleting an evaluation blob whose Flag id cannot be identified", async () => {
    const key = flagConfigKey(ids.appId, ids.environmentId, ids.flagKey);
    await h.kv.put(key, "corrupt evaluation snapshot");

    await expect(
      deleteFlagConfigSnapshot(
        h.kv,
        envScope(ids.appId, ids.environmentId),
        ids.flagId,
        1,
        ids.flagKey,
        null,
      ),
    ).rejects.toThrow();

    expect(await h.kv.get(key, "text")).toBe("corrupt evaluation snapshot");
  });
});
