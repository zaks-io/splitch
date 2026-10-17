import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import {
  activationConfigKey,
  CURRENT_KV_SCHEMA_VERSION,
  controlPlaneFlagConfigKey,
  experimentConfigKey,
  flagConfigKey,
  liveRunKey,
  runConfigKey,
} from "@splitch/contracts";
import { appScope, envScope } from "@splitch/db";
import { flagRow } from "@splitch/db/testing";
import { expect, it } from "vitest";
import { makeConfigStore } from "../src/config-store";
import { ids, kvJson, NOW, startSeededExperiment } from "../src/config-store-harness-core";
import { makeDurableConfigStoreProjectionJournal } from "../src/config-store-projection-journal";
import { makeDurableSnapshotRevisionAllocator } from "../src/config-store-snapshot-revision";
import { deleteFlagD1Cascade } from "../src/flag-config-lifecycle";
import { makePoolHarness } from "./config-store-pool-harness";

it("keeps permanent Flag deletion's public tombstone TTL and unrelated Activation bindings", async () => {
  const h = await makePoolHarness();
  const identity = { appId: ids.appId, environmentId: ids.environmentId, flagId: ids.flagId };
  const stub = env.CONFIG_STORE_WRITER.getByName(`${ids.appId}:${ids.environmentId}`);
  await startSeededExperiment(h.d1);
  expect(
    await stub.syncExperimentConfig({ ...identity, experimentId: ids.experimentId }),
  ).toMatchObject({ ok: true });
  const activationKey = activationConfigKey(ids.appId, ids.environmentId);
  const unrelated = {
    eventDefinitionId: "event_unrelated",
    experimentId: "exp_unrelated",
    runId: "run_unrelated",
    idType: "user",
  };
  await h.kv.put(
    activationKey,
    JSON.stringify({
      schemaVersion: CURRENT_KV_SCHEMA_VERSION,
      data: {
        bindings: [
          unrelated,
          { ...unrelated, experimentId: ids.experimentId, runId: ids.liveRunId },
        ],
      },
    }),
  );
  await h.d1
    .prepare("UPDATE experiments SET status = 'archived', live_run_id = NULL WHERE id = ?")
    .bind(ids.experimentId)
    .run();
  const captured = await stub.readFlagConfigPurgeTarget(identity);
  if (!captured.ok) throw new Error("expected a purge target");
  await h.repo.flags.removeFlagConfig(envScope(ids.appId, ids.environmentId), ids.flagId);

  const before = Math.floor(Date.now() / 1_000);
  expect(
    await stub.deleteFlagConfig({ ...identity, experimentIds: captured.experimentIds }),
  ).toMatchObject({ ok: true, snapshotRevision: 2 });
  const snapshotKey = controlPlaneFlagConfigKey(ids.appId, ids.environmentId, ids.flagId);
  expect(await kvJson(h.kv, snapshotKey)).toMatchObject({
    state: "deleted",
    revision: 2,
  });
  const tombstone = (await h.kv.list({ prefix: snapshotKey })).keys.find(
    (key) => key.name === snapshotKey,
  );
  expect(tombstone?.expiration).toBeGreaterThanOrEqual(before + 62);
  expect(tombstone?.expiration).toBeLessThanOrEqual(Math.floor(Date.now() / 1_000) + 62);
  for (const key of [
    flagConfigKey(ids.appId, ids.environmentId, ids.flagKey),
    experimentConfigKey(ids.appId, ids.environmentId, ids.experimentId),
    liveRunKey(ids.appId, ids.environmentId, ids.experimentId),
  ])
    expect(await h.kv.get(key)).toBeNull();
  expect(await h.kv.get(runConfigKey(ids.appId, ids.environmentId, ids.liveRunId))).not.toBeNull();
  expect(await kvJson(h.kv, activationKey)).toMatchObject({
    data: { bindings: [unrelated] },
  });
  expect(
    await h.repo.identity.getEnvironment(appScope(ids.appId), ids.environmentId),
  ).toMatchObject({ expiresAt: null });
  await evictDurableObject(stub);
  const retained = await runInDurableObject(stub, async (_instance, ctx) =>
    makeDurableConfigStoreProjectionJournal(ctx.storage).list(),
  );
  expect(retained).toEqual([]);
});

it("leaves no permanent projection journal after Flag creation, deletion and tombstone expiry", async () => {
  const h = await makePoolHarness();
  const identity = {
    appId: ids.appId,
    environmentId: ids.environmentId,
    flagId: "flag_expiring_journal",
  };
  const flagKey = "expiring-journal";
  const variantId = "var_expiring_journal";
  await h.repo.flags.flags.insert(
    appScope(ids.appId),
    flagRow({
      id: identity.flagId,
      appId: ids.appId,
      key: flagKey,
      name: "Expiring journal",
      lifecycleClass: "ops",
      defaultVariantId: variantId,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
  await h.repo.flags.addVariant(appScope(ids.appId), identity.flagId, {
    id: variantId,
    name: "control",
    value: "false",
    createdAt: NOW,
  });
  const stub = env.CONFIG_STORE_WRITER.getByName(`${ids.appId}:${ids.environmentId}`);
  await runInDurableObject(stub, async (_instance, ctx) => {
    let time = 0;
    const values = new Map<string, { value: string; expiresAt: number | null }>();
    const kv = {
      async put(key: string, value: string, options?: KVNamespacePutOptions) {
        values.set(key, {
          value,
          expiresAt:
            options?.expirationTtl === undefined ? null : time + options.expirationTtl * 1_000,
        });
      },
      async get(key: string) {
        const entry = values.get(key);
        return entry && (entry.expiresAt === null || entry.expiresAt > time) ? entry.value : null;
      },
      async delete(key: string) {
        values.delete(key);
      },
    } as unknown as KVNamespace;
    const journal = makeDurableConfigStoreProjectionJournal(ctx.storage);
    const writer = makeConfigStore({
      repo: h.repo,
      kv,
      projectionJournal: journal,
      nextSnapshotRevision: makeDurableSnapshotRevisionAllocator(ctx.storage),
      broadcaster: { broadcast() {} },
    });
    expect(
      await writer.resyncFlagConfig({
        ...identity,
        initialConfig: { defaultVariantId: variantId },
      }),
    ).toMatchObject({ ok: true });
    expect(await journal.list()).toEqual([]);
    const key = controlPlaneFlagConfigKey(ids.appId, ids.environmentId, identity.flagId);
    expect(await kv.get(key)).not.toBeNull();
    await deleteFlagD1Cascade({ repo: h.repo }, ids.appId, identity.flagId);
    expect(
      await writer.deleteFlagConfig({ ...identity, flagKey, experimentIds: [] }),
    ).toMatchObject({ ok: true });
    expect(await kv.get(key)).not.toBeNull();
    expect(await journal.list()).toEqual([]);
    time = 63_000;
    expect(await kv.get(key)).toBeNull();
    expect(await kv.get(flagConfigKey(ids.appId, ids.environmentId, flagKey))).toBeNull();
    expect(await journal.list()).toEqual([]);
  });
  await evictDurableObject(stub);
  expect(
    await runInDurableObject(stub, async (_instance, ctx) =>
      makeDurableConfigStoreProjectionJournal(ctx.storage).list(),
    ),
  ).toEqual([]);
});
