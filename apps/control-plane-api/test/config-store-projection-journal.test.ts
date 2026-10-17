import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import {
  activationConfigKey,
  controlPlaneFlagConfigKey,
  experimentConfigKey,
  flagConfigKey,
  liveRunKey,
  runConfigKey,
} from "@splitch/contracts";
import { envScope } from "@splitch/db";
import { beforeEach, expect, it } from "vitest";
import { makeConfigStore } from "../src/config-store";
import { makeSnapshotRevisionCounter } from "../src/config-store-fixture-data";
import { type Harness, ids, kvJson, startSeededExperiment } from "../src/config-store-harness-core";
import {
  journaledConfigStoreKv,
  makeDurableConfigStoreProjectionJournal,
} from "../src/config-store-projection-journal";
import { makePoolHarness } from "./config-store-pool-harness";

let h: Harness;
const identity = { appId: ids.appId, environmentId: ids.devEnvironmentId, flagId: ids.flagId };
const keys = [
  controlPlaneFlagConfigKey(identity.appId, identity.environmentId, identity.flagId),
  flagConfigKey(identity.appId, identity.environmentId, ids.flagKey),
];

beforeEach(async () => {
  h = await makePoolHarness();
  for (const environmentId of [ids.environmentId, ids.devEnvironmentId]) {
    const stub = env.CONFIG_STORE_WRITER.getByName(`${ids.appId}:${environmentId}`);
    await runInDurableObject(stub, async (_instance, ctx) => ctx.storage.deleteAll());
    await evictDurableObject(stub);
  }
});

it.each(
  ["permanent", "temporary"].flatMap((kind) =>
    ["cache-miss repair", "explicit repair", "resync", "write"].map((operation) => ({
      kind,
      operation,
    })),
  ),
)(
  "selects $kind journaling for $operation through the production writer",
  async ({ kind, operation }) => {
    if (kind === "temporary") await makeTemporary(identity.environmentId);
    const stub = env.CONFIG_STORE_WRITER.getByName(`${identity.appId}:${identity.environmentId}`);
    const result =
      operation === "cache-miss repair"
        ? await stub.readFlagConfig(identity)
        : operation === "explicit repair"
          ? await stub.repairFlagConfigSnapshot(identity)
          : operation === "resync"
            ? await stub.resyncFlagConfig(identity)
            : await stub.writeFlagConfig({
                ...identity,
                enabled: false,
                actor: { ref: "user_journal", via: "session" },
              });
    expect(result).toMatchObject({ ok: true });
    await evictDurableObject(stub);
    const recorded = await runInDurableObject(stub, async (_instance, ctx) =>
      makeDurableConfigStoreProjectionJournal(ctx.storage).list(),
    );
    expect(recorded.toSorted()).toEqual(kind === "temporary" ? keys.toSorted() : []);
    for (const key of keys) expect(await h.kv.get(key)).not.toBeNull();
  },
);

it("journals a live Temporary Environment's deletion tombstone and Activation publication", async () => {
  await makeTemporary(identity.environmentId);
  const stub = env.CONFIG_STORE_WRITER.getByName(`${identity.appId}:${identity.environmentId}`);
  await h.repo.flags.removeTargetingRules(
    envScope(identity.appId, identity.environmentId),
    identity.flagId,
  );
  await h.repo.flags.removeFlagConfig(
    envScope(identity.appId, identity.environmentId),
    identity.flagId,
  );

  expect(await stub.deleteFlagConfig({ ...identity, experimentIds: [] })).toMatchObject({
    ok: true,
    snapshotRevision: 1,
  });
  await evictDurableObject(stub);
  const recorded = await runInDurableObject(stub, async (_instance, ctx) =>
    makeDurableConfigStoreProjectionJournal(ctx.storage).list(),
  );
  expect(recorded.toSorted()).toEqual(
    [keys[0], activationConfigKey(identity.appId, identity.environmentId)].toSorted(),
  );
  expect(await kvJson(h.kv, keys[0])).toMatchObject({ state: "deleted", revision: 1 });
  expect(
    await h.kv.get(activationConfigKey(identity.appId, identity.environmentId)),
  ).not.toBeNull();
});

async function makeTemporary(environmentId: string) {
  await h.d1
    .prepare(
      "UPDATE environments SET expires_at = ?, synced_from_environment_id = ?, synced_at = ? WHERE id = ?",
    )
    .bind(
      new Date(Date.now() + 60_000).toISOString(),
      ids.environmentId,
      new Date().toISOString(),
      environmentId,
    )
    .run();
}

it("publishes permanent Experiment, Run, live Run and Activation projections without journaling", async () => {
  await startSeededExperiment(h.d1);
  const stub = env.CONFIG_STORE_WRITER.getByName(`${ids.appId}:${ids.environmentId}`);
  expect(
    await stub.syncExperimentConfig({
      appId: ids.appId,
      environmentId: ids.environmentId,
      experimentId: ids.experimentId,
    }),
  ).toMatchObject({ ok: true });
  const recorded = await runInDurableObject(stub, async (_instance, ctx) =>
    makeDurableConfigStoreProjectionJournal(ctx.storage).list(),
  );
  expect(recorded).toEqual([]);
  const published = [
    controlPlaneFlagConfigKey(ids.appId, ids.environmentId, ids.flagId),
    flagConfigKey(ids.appId, ids.environmentId, ids.flagKey),
    experimentConfigKey(ids.appId, ids.environmentId, ids.experimentId),
    runConfigKey(ids.appId, ids.environmentId, ids.liveRunId),
    liveRunKey(ids.appId, ids.environmentId, ids.experimentId),
    activationConfigKey(ids.appId, ids.environmentId),
  ];
  for (const key of published) expect(await h.kv.get(key)).not.toBeNull();
});

it("retains the durable journal after a partial snapshot publication", async () => {
  await makeTemporary(identity.environmentId);
  const stub = env.CONFIG_STORE_WRITER.getByName(`${identity.appId}:${identity.environmentId}`);
  await runInDurableObject(stub, async (_instance, ctx) => {
    const kv = new Proxy(env.CONFIG_STORE, {
      get(target, property) {
        if (property === "put")
          return async (...args: Parameters<KVNamespace["put"]>) => {
            if (args[0] === keys[1]) throw new Error("partial publication");
            return target.put(...args);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const writer = makeConfigStore({
      repo: h.repo,
      kv,
      projectionJournal: makeDurableConfigStoreProjectionJournal(ctx.storage),
      nextSnapshotRevision: makeSnapshotRevisionCounter(),
      broadcaster: { broadcast() {} },
    });
    await expect(writer.resyncFlagConfig(identity)).rejects.toThrow("partial publication");
  });
  expect(await h.kv.get(keys[0])).not.toBeNull();
  expect(await h.kv.get(keys[1])).toBeNull();
  await evictDurableObject(stub);
  const recorded = await runInDurableObject(stub, async (_instance, ctx) =>
    makeDurableConfigStoreProjectionJournal(ctx.storage).list(),
  );
  expect(recorded.toSorted()).toEqual(keys.toSorted());
});

it("recovers more than 1,000 journal entries after actual Durable Object eviction", async () => {
  const stub = env.CONFIG_STORE_WRITER.getByName("projection-journal-pagination");
  const expected = Array.from(
    { length: 1_105 },
    (_, i) => `flag:churn:${String(i).padStart(4, "0")}`,
  );
  await runInDurableObject(stub, async (_instance, ctx) => {
    const journal = makeDurableConfigStoreProjectionJournal(ctx.storage);
    for (let offset = 0; offset < expected.length; offset += 100)
      await Promise.all(expected.slice(offset, offset + 100).map((key) => journal.record(key)));
  });
  await evictDurableObject(stub);
  const recovered = await runInDurableObject(stub, async (_instance, ctx) =>
    makeDurableConfigStoreProjectionJournal(ctx.storage).list(),
  );
  expect(recovered).toEqual(expected);
});

it("preserves native KV receivers and rejects corrupt durable journal entries", async () => {
  const stub = env.CONFIG_STORE_WRITER.getByName("projection-journal-native-kv");
  await runInDurableObject(stub, async (_instance, ctx) => {
    const journal = makeDurableConfigStoreProjectionJournal(ctx.storage);
    const kv = journaledConfigStoreKv(env.CONFIG_STORE, journal);
    await kv.put("journal:native", "snapshot");
    expect(await kv.get("journal:native")).toBe("snapshot");
    expect((await kv.list({ prefix: "journal:native" })).keys).toHaveLength(1);
    await kv.delete("journal:native");
    expect(await kv.get("journal:native")).toBeNull();
    expect(await journal.list()).toEqual(["journal:native"]);
    await ctx.storage.put("projection-key:corrupt", false);
    await expect(journal.list()).rejects.toThrow("invalid projection journal entry");
  });
});
