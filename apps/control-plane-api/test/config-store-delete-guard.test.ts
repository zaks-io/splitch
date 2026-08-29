import { flagConfigKey } from "@splitch/contracts";
import { envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeConfigStore } from "../src/config-store";
import { makeSnapshotRevisionCounter } from "../src/config-store-fixture-data";
import { type Harness, ids, NOW_MS } from "../src/config-store-harness-core";
import { makePoolHarness } from "./config-store-pool-harness";

let h: Harness;

beforeEach(async () => {
  h = await makePoolHarness();
});

afterEach(async () => {
  await h.dispose();
});

describe("Flag Configuration delete ownership guard", () => {
  it("reports and deletes a malformed evaluation blob using D1 authority", async () => {
    const key = flagConfigKey(ids.appId, ids.environmentId, ids.flagKey);
    await h.kv.put(key, "corrupt evaluation snapshot");
    const store = makeConfigStore({
      repo: h.repo,
      kv: h.kv,
      broadcaster: { broadcast: async () => {} },
      logger: { warn: (...args) => h.warnings.push(args) },
      nextSnapshotRevision: makeSnapshotRevisionCounter(),
      now: () => new Date(NOW_MS),
    });
    const captured = await store.readFlagConfigPurgeTarget({
      appId: ids.appId,
      environmentId: ids.environmentId,
      flagId: ids.flagId,
    });
    expect(captured).toMatchObject({ ok: true, experimentIds: [ids.experimentId] });
    if (!captured.ok) throw new Error("expected a purge target");
    await h.repo.flags.removeFlagConfig(envScope(ids.appId, ids.environmentId), ids.flagId);

    await expect(
      store.deleteFlagConfig({
        appId: ids.appId,
        environmentId: ids.environmentId,
        flagId: ids.flagId,
        experimentIds: captured.experimentIds,
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(h.warnings).toContainEqual([
      "config_store_kv_schema_mismatch",
      expect.objectContaining({ key, cause: expect.anything() }),
    ]);
    expect(await h.kv.get(key, "text")).toBeNull();
  });

  it("deletes the evaluation blob when its KV ownership read is a cached miss", async () => {
    const key = flagConfigKey(ids.appId, ids.environmentId, ids.flagKey);
    const kv = negativeEvaluationReadKv(h.kv, key);
    const store = makeConfigStore({
      repo: h.repo,
      kv,
      broadcaster: { broadcast: async () => {} },
      nextSnapshotRevision: makeSnapshotRevisionCounter(),
      now: () => new Date(NOW_MS),
    });
    await store.resyncFlagConfig({
      appId: ids.appId,
      environmentId: ids.environmentId,
      flagId: ids.flagId,
    });
    expect(await h.kv.get(key, "text")).not.toBeNull();
    const captured = await store.readFlagConfigPurgeTarget({
      appId: ids.appId,
      environmentId: ids.environmentId,
      flagId: ids.flagId,
    });
    if (!captured.ok) throw new Error("expected a purge target");
    await h.repo.flags.removeFlagConfig(envScope(ids.appId, ids.environmentId), ids.flagId);

    await store.deleteFlagConfig({
      appId: ids.appId,
      environmentId: ids.environmentId,
      flagId: ids.flagId,
      experimentIds: captured.experimentIds,
    });

    expect(await h.kv.get(key, "text")).toBeNull();
  });
});

function negativeEvaluationReadKv(base: KVNamespace, evaluationKey: string): KVNamespace {
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === "get") {
        return (...args: Parameters<KVNamespace["get"]>) =>
          args[0] === evaluationKey ? Promise.resolve(null) : target.get(...args);
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as KVNamespace;
}
