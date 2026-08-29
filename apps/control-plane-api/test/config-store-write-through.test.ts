import { describe, expect, it } from "vitest";
import type { ControlPlaneFlagConfigSnapshot } from "../src/config-store-kv";
import { configStoreWriteThrough } from "../src/config-store-write-through";

describe("Config Store isolate write-through bounds", () => {
  it("evicts the least recently used entry at the hard cap", () => {
    const entries = new Map<string, ControlPlaneFlagConfigSnapshot>();
    const cache = configStoreWriteThrough(entries, { maxEntries: 2 });
    cache.set("flag-a", deletedSnapshot("flag_a"));
    cache.set("flag-b", deletedSnapshot("flag_b"));

    expect(cache.get("flag-a")).toMatchObject({ flagId: "flag_a" });
    cache.set("flag-c", deletedSnapshot("flag_c"));

    expect([...entries.keys()]).toEqual(["flag-a", "flag-c"]);
    expect(cache.get("flag-b")).toBeUndefined();
  });

  it("expires entries after the KV convergence window", () => {
    let now = 0;
    const entries = new Map<string, ControlPlaneFlagConfigSnapshot>();
    const cache = configStoreWriteThrough(entries, { now: () => now, ttlMs: 60_000 });
    cache.set("flag-a", deletedSnapshot("flag_a"));

    now = 59_999;
    expect(cache.get("flag-a")).toMatchObject({ flagId: "flag_a" });
    now = 60_000;
    expect(cache.get("flag-a")).toBeUndefined();
    expect(entries).toHaveLength(0);
  });
});

function deletedSnapshot(flagId: string): ControlPlaneFlagConfigSnapshot {
  return {
    appId: "app_1",
    environmentId: "env_1",
    flagId,
    revision: 1,
    state: "deleted",
  };
}
