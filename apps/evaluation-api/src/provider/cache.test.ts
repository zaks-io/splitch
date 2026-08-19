import type { DeltaNudge } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { FlagConfigCache } from "./cache";
import { flagConfigKV } from "./fixtures";
import { flagConfigFromKV } from "./resolve";

const nudge: DeltaNudge = { type: "config.changed", entity: "flag", id: "flag-id-1", version: 2 };

function config(appId: string, environmentId: string, version = 1) {
  const blob = flagConfigKV({ environmentId });
  return { blob, resolved: flagConfigFromKV(appId, blob), version };
}

describe("FlagConfigCache", () => {
  it("stores and returns config by its app-scoped KV key", () => {
    const cache = new FlagConfigCache();
    const key = "app:app-A:env-1:flag:checkout-banner";
    const value = config("app-A", "env-1");
    cache.set(key, value.blob.id, value.version, value.resolved);
    expect(cache.get(key)?.config.appId).toBe("app-A");
  });

  it("a DeltaNudge invalidates only the affected App and Environment entry", () => {
    const cache = new FlagConfigCache();
    const appAEnv1 = config("app-A", "env-1");
    const appAEnv2 = config("app-A", "env-2");
    const appB = config("app-B", "env-1");
    cache.set("app:app-A:env-1:flag:f", appAEnv1.blob.id, appAEnv1.version, appAEnv1.resolved);
    cache.set("app:app-A:env-2:flag:f", appAEnv2.blob.id, appAEnv2.version, appAEnv2.resolved);
    cache.set("app:app-B:env-1:flag:f", appB.blob.id, appB.version, appB.resolved);

    cache.invalidate("app-A", "env-1", nudge, 100);

    expect(cache.get("app:app-A:env-1:flag:f")).toBeUndefined();
    expect(cache.get("app:app-A:env-2:flag:f")?.config.appId).toBe("app-A");
    expect(cache.get("app:app-B:env-1:flag:f")?.config.appId).toBe("app-B");
  });

  it("reconnect invalidates one Environment before its next read", () => {
    const cache = new FlagConfigCache();
    const env1 = config("app-A", "env-1");
    const env2 = config("app-A", "env-2");
    cache.set("app:app-A:env-1:flag:f", env1.blob.id, env1.version, env1.resolved);
    cache.set("app:app-A:env-2:flag:g", env2.blob.id, env2.version, env2.resolved);
    expect(cache.size).toBe(2);

    cache.invalidateEnvironment("app-A", "env-1");
    expect(cache.size).toBe(1);
  });

  it("rejects a stale cache fill racing with a same-or-newer nudge", () => {
    const cache = new FlagConfigCache();
    const value = config("app-A", "env-1");
    cache.invalidate("app-A", "env-1", nudge, 100);

    expect(cache.set("app:app-A:env-1:flag:f", value.blob.id, value.version, value.resolved)).toBe(
      false,
    );
    expect(cache.size).toBe(0);
  });

  it("invalidates on a same-version nudge because related experiment state may have changed", () => {
    const cache = new FlagConfigCache();
    const value = config("app-A", "env-1");
    cache.set("app:app-A:env-1:flag:f", value.blob.id, value.version, value.resolved);

    cache.invalidate("app-A", "env-1", { ...nudge, version: value.version }, 100);

    expect(cache.size).toBe(0);
  });
});
