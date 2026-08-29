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
  it("deletes a malformed evaluation snapshot without reading it for ownership", async () => {
    const key = flagConfigKey(ids.appId, ids.environmentId, ids.flagKey);
    await h.kv.put(key, "corrupt evaluation snapshot");
    const reads: string[] = [];
    const kv = trackingEvaluationReadKv(h.kv, key, reads);
    const store = makeConfigStore({
      repo: h.repo,
      kv,
      broadcaster: { broadcast: async () => {} },
      logger: { error: () => {}, warn: (...args) => h.warnings.push(args) },
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

    expect(reads).toEqual([]);
    expect(h.warnings).toEqual([]);
    expect(await h.kv.get(key, "text")).toBeNull();
  });
});

function trackingEvaluationReadKv(
  base: KVNamespace,
  evaluationKey: string,
  reads: string[],
): KVNamespace {
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === "get") {
        return (...args: Parameters<KVNamespace["get"]>) => {
          if (args[0] === evaluationKey) reads.push(args[0]);
          return target.get(...args);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as KVNamespace;
}
