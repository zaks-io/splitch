import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ConfigStoreDeps, type ConfigStoreWriter, makeConfigStore } from "../src/config-store";
import { type Harness, ids } from "../src/config-store-harness-core";
import { controlPlaneFlagConfigKey } from "../src/config-store-kv";
import { makeDurableSnapshotRevisionAllocator } from "../src/config-store-snapshot-revision";
import { makePoolHarness } from "./config-store-pool-harness";

let h: Harness;

beforeEach(async () => {
  h = await makePoolHarness();
});

afterEach(async () => {
  await h.dispose();
});

describe("Flag Configuration snapshot publication order", () => {
  it("serializes a delete behind an in-flight repair KV write", async () => {
    const key = snapshotKey();
    const deferred = deferredPresentSnapshotPut(h.kv, key);
    const store = makeStore(deferred.kv);
    expect(await store.resyncFlagConfig(configIdentity())).toMatchObject({ ok: true });

    deferred.arm();
    const repair = store.repairFlagConfigSnapshot(configIdentity());
    await deferred.paused;
    const deletion = store.deleteFlagConfig(configIdentity());

    expect(await settlesWithin(deletion, 25)).toBe(false);
    deferred.release();
    expect(await repair).toMatchObject({ ok: true, snapshotRevision: 2 });
    expect(await deletion).toMatchObject({ ok: true, snapshotRevision: 3 });
    expect(JSON.parse(await requiredSnapshot(key))).toMatchObject({
      revision: 3,
      state: "deleted",
    });
  });

  it("refuses a normal write that reaches publication after deletion", async () => {
    const store = makeStore(h.kv);
    expect(await store.resyncFlagConfig(configIdentity())).toMatchObject({ ok: true });
    const pausedWrite = pauseFirstReadAfterConfigCommit();

    const write = store.writeFlagConfig({
      ...configIdentity(),
      actor: { ref: "user_spl_526", via: "session" },
      enabled: true,
    });
    await pausedWrite.paused;
    expect(await store.deleteFlagConfig(configIdentity())).toMatchObject({
      ok: true,
      snapshotRevision: 2,
    });

    pausedWrite.release();
    expect(await write).toEqual({ ok: false, reason: "FLAG_NOT_FOUND" });
    expect(JSON.parse(await requiredSnapshot(snapshotKey()))).toMatchObject({
      revision: 2,
      state: "deleted",
    });
  });
});

function makeStore(kv: KVNamespace): ConfigStoreWriter {
  return makeConfigStore({
    repo: h.repo,
    kv,
    broadcaster: { broadcast: () => undefined },
    nextSnapshotRevision: durableRevisionAllocator(),
  });
}

function configIdentity() {
  return { appId: ids.appId, environmentId: ids.environmentId, flagId: ids.flagId };
}

function snapshotKey(): string {
  return controlPlaneFlagConfigKey(
    { appId: ids.appId, environmentId: ids.environmentId },
    ids.flagId,
  );
}

async function requiredSnapshot(key: string): Promise<string> {
  const snapshot = await h.kv.get(key, "text");
  if (snapshot === null) throw new Error(`test snapshot is missing: ${key}`);
  return snapshot;
}

function durableRevisionAllocator(): ConfigStoreDeps["nextSnapshotRevision"] {
  const values = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => values.get(key),
    put: async (entries: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(entries)) values.set(key, value);
    },
  } as unknown as DurableObjectStorage;
  return makeDurableSnapshotRevisionAllocator(storage);
}

function deferredPresentSnapshotPut(base: KVNamespace, key: string) {
  let armed = false;
  const deferred = gate();
  const kv = new Proxy(base, {
    get(target, property) {
      if (property === "put") {
        return async (requestedKey: string, value: string, options?: KVNamespacePutOptions) => {
          if (armed && requestedKey === key && JSON.parse(value).state === "present") {
            armed = false;
            deferred.markPaused();
            await deferred.wait;
          }
          return target.put(requestedKey, value, options);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { kv, paused: deferred.paused, arm: () => (armed = true), release: deferred.release };
}

async function settlesWithin<T>(promise: Promise<T>, milliseconds: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), milliseconds)),
  ]);
}

function pauseFirstReadAfterConfigCommit() {
  let shouldPause = false;
  const deferred = gate();
  const updateFlagConfig = h.repo.flags.updateFlagConfig;
  h.repo.flags.updateFlagConfig = async (...args) => {
    const result = await updateFlagConfig(...args);
    if (result) shouldPause = true;
    return result;
  };
  const getFlagConfig = h.repo.flags.getFlagConfig;
  h.repo.flags.getFlagConfig = async (...args) => {
    if (shouldPause) {
      shouldPause = false;
      deferred.markPaused();
      await deferred.wait;
    }
    return getFlagConfig(...args);
  };
  return { paused: deferred.paused, release: deferred.release };
}

function gate() {
  let release!: () => void;
  let markPaused!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    markPaused = resolve;
  });
  return { wait, paused, release, markPaused };
}
