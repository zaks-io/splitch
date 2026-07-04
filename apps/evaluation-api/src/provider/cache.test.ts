import type { DeltaNudge } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { FlagConfigCache } from "./cache";
import { flagConfigFromKV } from "./resolve";
import { flagConfigKV } from "./fixtures";

const nudge: DeltaNudge = { type: "config.changed", entity: "flag", id: "flag-id-1", version: 2 };

function config(appId: string, environmentId: string) {
  return flagConfigFromKV(appId, flagConfigKV({ environmentId }));
}

describe("FlagConfigCache", () => {
  it("stores and returns config by its app-scoped KV key", () => {
    const cache = new FlagConfigCache();
    const key = "app:app-A:env-1:flag:checkout-banner";
    cache.set(key, config("app-A", "env-1"));
    expect(cache.get(key)?.appId).toBe("app-A");
  });

  it("a DeltaNudge invalidates only the affected App's entries", () => {
    const cache = new FlagConfigCache();
    cache.set("app:app-A:env-1:flag:f", config("app-A", "env-1"));
    cache.set("app:app-B:env-1:flag:f", config("app-B", "env-1"));

    cache.invalidateApp("app-A", nudge);

    expect(cache.get("app:app-A:env-1:flag:f")).toBeUndefined();
    expect(cache.get("app:app-B:env-1:flag:f")?.appId).toBe("app-B");
  });

  it("invalidateApp re-fetches on next read (entry gone, size drops)", () => {
    const cache = new FlagConfigCache();
    cache.set("app:app-A:env-1:flag:f", config("app-A", "env-1"));
    cache.set("app:app-A:env-2:flag:g", config("app-A", "env-2"));
    expect(cache.size).toBe(2);

    cache.invalidateApp("app-A", nudge);
    expect(cache.size).toBe(0);
  });
});
