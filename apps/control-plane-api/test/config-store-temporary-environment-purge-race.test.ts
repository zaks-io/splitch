import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { controlPlaneFlagConfigKey, flagConfigKey } from "@splitch/contracts";
import { appScope, envScope } from "@splitch/db";
import { flagRow } from "@splitch/db/testing";
import { beforeEach, expect, it, vi } from "vitest";
import { durableConfigStoreAccess } from "../src/config-store-access";
import { type Harness, ids, NOW } from "../src/config-store-harness-core";
import { makeDurableConfigStoreProjectionJournal } from "../src/config-store-projection-journal";
import { captureFlagConfigPurgeTargets, deleteFlagD1Cascade } from "../src/flag-config-lifecycle";
import { teardownTemporaryEnvironment } from "../src/temporary-environment-teardown";
import { makePoolHarness } from "./config-store-pool-harness";

let h: Harness;
const flagId = "flag_late_purge";
const flagKey = "late-purge";
const variantId = "var_late_purge";
const environmentId = ids.devEnvironmentId;
const scope = envScope(ids.appId, environmentId);
const identity = { appId: ids.appId, environmentId, flagId };

beforeEach(async () => {
  h = await makePoolHarness();
  await h.d1
    .prepare(
      "UPDATE environments SET expires_at = ?, synced_from_environment_id = ?, synced_at = ? WHERE id = ?",
    )
    .bind(new Date(Date.now() + 60_000).toISOString(), ids.environmentId, NOW, environmentId)
    .run();
  await h.repo.flags.flags.insert(
    appScope(ids.appId),
    flagRow({
      id: flagId,
      appId: ids.appId,
      key: flagKey,
      name: "Late purge",
      lifecycleClass: "ops",
      defaultVariantId: variantId,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
  await h.repo.flags.addVariant(appScope(ids.appId), flagId, {
    id: variantId,
    name: "control",
    value: "false",
    createdAt: NOW,
  });
});

it("retains the Environment and durable journal after projection deletion until an evicted writer retries state clear", async () => {
  const access = durableConfigStoreAccess(env.CONFIG_STORE_WRITER, h.kv);
  const writer = access.writerFor(ids.appId, environmentId);
  expect(
    await writer.resyncFlagConfig({ ...identity, initialConfig: { defaultVariantId: variantId } }),
  ).toMatchObject({ ok: true });
  const projectionKeys = [
    controlPlaneFlagConfigKey(ids.appId, environmentId, flagId),
    flagConfigKey(ids.appId, environmentId, flagKey),
  ];
  await captureFlagConfigPurgeTargets({ repo: h.repo, configStore: access }, ids.appId, flagId);
  await deleteFlagD1Cascade({ repo: h.repo }, ids.appId, flagId);
  const stub = env.CONFIG_STORE_WRITER.getByName(`${ids.appId}:${environmentId}`);
  const input = {
    appId: ids.appId,
    environmentId,
    orgId: ids.orgId,
    actorId: "user_eviction",
    requestId: "req_eviction",
  };
  const deps = {
    repo: h.repo,
    configStore: access,
    credentialStore: env.CREDENTIAL_STORE,
    exposureStatusCleanup: { delete: async () => {} },
    nowIso: () => new Date().toISOString(),
  };
  const failingAccess = {
    ...access,
    writerFor: () => ({
      ...writer,
      teardownTemporaryEnvironment: async () =>
        runInDurableObject(stub, async (instance, ctx) => {
          const clear = vi
            .spyOn(ctx.storage, "deleteAll")
            .mockRejectedValueOnce(new Error("interrupted state clear"));
          try {
            await instance.teardownTemporaryEnvironment(input);
          } finally {
            clear.mockRestore();
          }
        }),
    }),
  };

  await expect(
    teardownTemporaryEnvironment({ ...deps, configStore: failingAccess }, input),
  ).rejects.toThrow("interrupted state clear");
  expect(await h.repo.identity.getEnvironment(appScope(ids.appId), environmentId)).not.toBeNull();
  for (const key of projectionKeys) expect(await h.kv.get(key)).toBeNull();
  expect(
    await runInDurableObject(stub, async (_instance, ctx) =>
      makeDurableConfigStoreProjectionJournal(ctx.storage).list(),
    ),
  ).toEqual(expect.arrayContaining(projectionKeys));

  await evictDurableObject(stub);
  expect(
    await runInDurableObject(stub, async (_instance, ctx) =>
      makeDurableConfigStoreProjectionJournal(ctx.storage).list(),
    ),
  ).toEqual(expect.arrayContaining(projectionKeys));
  await teardownTemporaryEnvironment(deps, input);
  expect(await h.repo.identity.getEnvironment(appScope(ids.appId), environmentId)).toBeNull();
  expect(
    await runInDurableObject(stub, async (_instance, ctx) => (await ctx.storage.list()).size),
  ).toBe(0);
  for (const key of projectionKeys) expect(await h.kv.get(key)).toBeNull();
});

it("teardown deletes all projections after app-wide D1 deletion even when captured purge never resumes", async () => {
  const configStore = durableConfigStoreAccess(env.CONFIG_STORE_WRITER, h.kv);
  const lifecycle = { repo: h.repo, configStore };
  const writer = configStore.writerFor(ids.appId, environmentId);
  expect(
    await writer.resyncFlagConfig({
      ...identity,
      initialConfig: { defaultVariantId: variantId },
    }),
  ).toMatchObject({ ok: true });
  const projectionKeys = [
    controlPlaneFlagConfigKey(ids.appId, environmentId, flagId),
    flagConfigKey(ids.appId, environmentId, flagKey),
  ];
  for (const key of projectionKeys) expect(await h.kv.get(key)).not.toBeNull();
  const captured = await captureFlagConfigPurgeTargets(lifecycle, ids.appId, flagId);
  expect(captured).toContainEqual({ environmentId, experimentIds: [] });
  await deleteFlagD1Cascade(lifecycle, ids.appId, flagId);
  expect(await h.repo.flags.getFlagConfig(scope, flagId)).toBeNull();
  expect(await h.repo.flags.getFlag(appScope(ids.appId), flagId)).toBeNull();
  const stub = env.CONFIG_STORE_WRITER.getByName(`${ids.appId}:${environmentId}`);
  const assertExternalCleanup = vi.fn(async () => {
    expect(await h.repo.identity.getEnvironment(appScope(ids.appId), environmentId)).not.toBeNull();
    for (const key of projectionKeys) expect(await h.kv.get(key)).toBeNull();
    expect(
      await runInDurableObject(stub, async (_instance, ctx) => (await ctx.storage.list()).size),
    ).toBe(0);
  });

  await teardownTemporaryEnvironment(
    {
      ...lifecycle,
      credentialStore: env.CREDENTIAL_STORE,
      exposureStatusCleanup: { delete: assertExternalCleanup },
      nowIso: () => new Date().toISOString(),
    },
    {
      appId: ids.appId,
      environmentId,
      orgId: ids.orgId,
      actorId: "user_purge_race",
      requestId: "req_purge_race",
    },
  );
  expect(assertExternalCleanup).toHaveBeenCalledOnce();
  expect(await h.repo.identity.getEnvironment(appScope(ids.appId), environmentId)).toBeNull();
  for (const key of projectionKeys) expect(await h.kv.get(key)).toBeNull();
  expect(
    await runInDurableObject(stub, async (_instance, ctx) => (await ctx.storage.list()).size),
  ).toBe(0);
});

it("reports FLAG_NOT_FOUND when neither the purge key nor the deleted Flag can resolve its evaluation key", async () => {
  const configStore = durableConfigStoreAccess(env.CONFIG_STORE_WRITER, h.kv);
  await deleteFlagD1Cascade({ repo: h.repo }, ids.appId, flagId);
  await teardownTemporaryEnvironment(
    {
      repo: h.repo,
      configStore,
      credentialStore: env.CREDENTIAL_STORE,
      exposureStatusCleanup: { delete: async () => {} },
      nowIso: () => new Date().toISOString(),
    },
    {
      appId: ids.appId,
      environmentId,
      orgId: ids.orgId,
      actorId: "user_missing_key",
      requestId: "req_missing_key",
    },
  );
  expect(
    await configStore.writerFor(ids.appId, environmentId).deleteFlagConfig({
      ...identity,
      experimentIds: [],
    }),
  ).toEqual({ ok: false, reason: "FLAG_NOT_FOUND" });
});
