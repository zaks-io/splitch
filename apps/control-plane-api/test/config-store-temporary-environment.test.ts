import { activationConfigKey, controlPlaneFlagConfigKey, flagConfigKey } from "@splitch/contracts";
import { appScope, envScope } from "@splitch/db";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type ConfigStoreWriter, makeConfigStore } from "../src/config-store";
import { makeSnapshotRevisionCounter } from "../src/config-store-fixture-data";
import { type Harness, ids, kvJson, NOW, NOW_MS } from "../src/config-store-harness-core";
import { makeConfigStoreProjectionJournalFixture } from "../src/config-store-projection-journal-fixture";
import { makePoolHarness } from "./config-store-pool-harness";

let h: Harness;
let store: ConfigStoreWriter;
let projectionJournal: ReturnType<typeof makeConfigStoreProjectionJournalFixture>;
let now: number;
const scope = envScope(ids.appId, ids.devEnvironmentId);
const target = { appId: ids.appId, environmentId: ids.devEnvironmentId, flagId: ids.flagId };
const actor = { ref: "user_expiry", via: "session" } as const;
const expiry = "2026-07-01T20:01:00.000Z";

beforeEach(async () => {
  h = await makePoolHarness();
  now = NOW_MS;
  projectionJournal = makeConfigStoreProjectionJournalFixture();
  await h.d1
    .prepare(
      "UPDATE environments SET expires_at = ?, synced_from_environment_id = 'env_prod', synced_at = '2026-07-01T20:00:00.000Z' WHERE id = ?",
    )
    .bind(expiry, ids.devEnvironmentId)
    .run();
  store = makeConfigStore({
    projectionJournal,
    repo: h.repo,
    kv: h.kv,
    now: () => new Date(now),
    broadcaster: { broadcast() {} },
    nextSnapshotRevision: makeSnapshotRevisionCounter(),
    clearEnvironmentState: async () => projectionJournal.clear(),
  });
});
afterEach(() => vi.restoreAllMocks());

function mutationCalls() {
  const patch = { ...target, actor, enabled: false };
  const rules = { ...target, actor, targetingRules: [] };
  const promotion = {
    ...target,
    actor,
    targetEnvironmentId: target.environmentId,
    fromEnvironmentId: ids.environmentId,
    select: { enabled: true },
  };
  return {
    writeFlagConfig: () => store.writeFlagConfig(patch),
    replaceTargetingRules: () => store.replaceTargetingRules(rules),
    promoteFlagConfig: () => store.promoteFlagConfig(promotion),
    previewFlagConfig: () => store.previewFlagConfig(patch),
    previewTargetingRules: () => store.previewTargetingRules(rules),
    previewPromotion: () => store.previewPromotion(promotion),
    applyApprovedFlagConfig: () => store.applyApprovedFlagConfig(patch as never),
    syncExperimentConfig: () =>
      store.syncExperimentConfig({ ...target, experimentId: "exp_missing" }),
    resyncFlagConfig: () =>
      store.resyncFlagConfig({
        ...target,
        initialConfig: { defaultVariantId: ids.controlVariantId },
      }),
    repairFlagConfigSnapshot: () => store.repairFlagConfigSnapshot(target),
    syncFlagConfig: () =>
      store.syncFlagConfig({
        ...target,
        actor,
        fromEnvironmentId: ids.environmentId,
        initialConfig: { defaultVariantId: ids.controlVariantId },
      }),
  };
}

it("classifies every writer operation for the expiry fence", () => {
  const exempt = [
    "readFlagConfig",
    "readFlagConfigPurgeTarget",
    "deleteFlagConfig",
    "fenceTemporaryEnvironment",
    "teardownTemporaryEnvironment",
  ];
  expect([...Object.keys(mutationCalls()), ...exempt].sort()).toEqual(Object.keys(store).sort());
});

it.each(Object.keys(mutationCalls()))(
  "%s refuses expired and missing Environments before any write",
  async (method) => {
    const put = vi.spyOn(h.kv, "put");
    const initial = vi.spyOn(h.repo.flags, "ensureInitialFlagConfig");
    const call = mutationCalls()[method as keyof ReturnType<typeof mutationCalls>];
    now = Date.parse(expiry);
    const before = await h.repo.flags.getFlagConfig(scope, ids.flagId);
    expect(await call()).toEqual({ ok: false, reason: "ENVIRONMENT_EXPIRED", expiredAt: expiry });
    expect(await h.repo.flags.getFlagConfig(scope, ids.flagId)).toEqual(before);
    await h.repo.flags.removeTargetingRules(scope, ids.flagId);
    await h.repo.flags.removeFlagConfig(scope, ids.flagId);
    await h.repo.identity.deleteEnvironment(appScope(ids.appId), ids.devEnvironmentId);
    expect(await call()).toEqual({ ok: false, reason: "ENVIRONMENT_NOT_FOUND" });
    expect(initial).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  },
);

it("holds the fence behind D1 and KV, then refuses a queued write after it", async () => {
  const captured = gate();
  const release = gate();
  const original = h.repo.flags.updateFlagConfig.bind(h.repo.flags);
  const update = vi.spyOn(h.repo.flags, "updateFlagConfig").mockImplementation(async (...args) => {
    const row = await original(...args);
    captured.resolve();
    await release.promise;
    return row;
  });
  const writing = store.writeFlagConfig({ ...target, actor, enabled: false });
  await captured.promise;
  const fencing = store.fenceTemporaryEnvironment({ ...target, now: NOW });
  const lateWrite = store.writeFlagConfig({ ...target, actor, enabled: true });
  await Promise.resolve();
  expect(
    (await h.repo.identity.getEnvironment(appScope(ids.appId), target.environmentId))?.expiresAt,
  ).toBe(expiry);
  release.resolve();
  expect(await writing).toMatchObject({ ok: true });
  expect(await fencing).toEqual({ ok: true });
  expect(await lateWrite).toEqual({ ok: false, reason: "ENVIRONMENT_EXPIRED", expiredAt: NOW });
  expect(update).toHaveBeenCalledTimes(1);
  expect(
    await kvJson(h.kv, controlPlaneFlagConfigKey(ids.appId, target.environmentId, ids.flagId)),
  ).toMatchObject({ data: { enabled: false } });
});

it("fences provisioning inside its queue and never inserts after teardown", async () => {
  await h.repo.flags.removeTargetingRules(scope, ids.flagId);
  await h.repo.flags.removeFlagConfig(scope, ids.flagId);
  const fenced = store.fenceTemporaryEnvironment({ ...target, now: NOW });
  const initial = store.resyncFlagConfig({
    ...target,
    initialConfig: { defaultVariantId: ids.controlVariantId },
  });
  await fenced;
  expect(await initial).toEqual({ ok: false, reason: "ENVIRONMENT_EXPIRED", expiredAt: NOW });
  expect(await h.repo.flags.getFlagConfig(scope, ids.flagId)).toBeNull();
});

it("keeps initial D1 insertion and its publication ahead of a concurrent fence", async () => {
  await h.repo.flags.removeTargetingRules(scope, ids.flagId);
  await h.repo.flags.removeFlagConfig(scope, ids.flagId);
  const captured = gate();
  const release = gate();
  const insert = h.repo.flags.ensureInitialFlagConfig.bind(h.repo.flags);
  vi.spyOn(h.repo.flags, "ensureInitialFlagConfig").mockImplementation(async (...args) => {
    const row = await insert(...args);
    captured.resolve();
    await release.promise;
    return row;
  });
  const initial = store.resyncFlagConfig({
    ...target,
    initialConfig: { defaultVariantId: ids.controlVariantId },
  });
  await captured.promise;
  const fenced = store.fenceTemporaryEnvironment({ ...target, now: NOW });
  await Promise.resolve();
  expect(
    (await h.repo.identity.getEnvironment(appScope(ids.appId), target.environmentId))?.expiresAt,
  ).toBe(expiry);
  release.resolve();
  expect(await initial).toMatchObject({ ok: true });
  expect(await fenced).toEqual({ ok: true });
  expect(
    await kvJson(h.kv, controlPlaneFlagConfigKey(ids.appId, target.environmentId, ids.flagId)),
  ).toMatchObject({ data: { enabled: false } });
});

it("refuses publication when expiry passes during a D1 mutation", async () => {
  const original = h.repo.flags.updateFlagConfig.bind(h.repo.flags);
  vi.spyOn(h.repo.flags, "updateFlagConfig").mockImplementation(async (...args) => {
    const row = await original(...args);
    now = Date.parse(expiry);
    return row;
  });
  expect(await store.writeFlagConfig({ ...target, actor, enabled: false })).toEqual({
    ok: false,
    reason: "ENVIRONMENT_EXPIRED",
    expiredAt: expiry,
  });
  expect(await h.kv.get(flagConfigKey(ids.appId, target.environmentId, ids.flagKey))).toBeNull();
});

it("keeps expired configuration readable without repairing KV, and permits removal", async () => {
  now = Date.parse(expiry);
  expect(await store.readFlagConfig(target)).toMatchObject({ ok: true, config: { enabled: true } });
  expect(await h.kv.get(flagConfigKey(ids.appId, target.environmentId, ids.flagKey))).toBeNull();
  await h.repo.flags.removeTargetingRules(scope, ids.flagId);
  await h.repo.flags.removeFlagConfig(scope, ids.flagId);
  expect(await store.deleteFlagConfig({ ...target, experimentIds: [] })).toMatchObject({
    ok: true,
  });
});

it("teardown removes external state while retaining the D1 manifest and ordinary delete guard", async () => {
  expect(await store.resyncFlagConfig(target)).toMatchObject({ ok: true });
  await expect(store.deleteFlagConfig({ ...target, experimentIds: [] })).rejects.toThrow(
    "exists in D1",
  );
  await projectionJournal.record(activationConfigKey(ids.appId, target.environmentId));
  await h.kv.put(activationConfigKey(ids.appId, target.environmentId), "stale bindings");
  await store.fenceTemporaryEnvironment({ ...target, now: NOW });
  await store.teardownTemporaryEnvironment(target);
  expect(
    await h.kv.get(controlPlaneFlagConfigKey(ids.appId, target.environmentId, ids.flagId)),
  ).toBeNull();
  expect(await h.kv.get(flagConfigKey(ids.appId, target.environmentId, ids.flagKey))).toBeNull();
  expect(await h.kv.get(activationConfigKey(ids.appId, target.environmentId))).toBeNull();
  expect(await h.repo.flags.getFlagConfig(scope, ids.flagId)).not.toBeNull();
  expect(
    await h.repo.identity.getEnvironment(appScope(ids.appId), target.environmentId),
  ).not.toBeNull();
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
