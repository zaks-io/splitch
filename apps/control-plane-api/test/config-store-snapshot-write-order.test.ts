import { controlPlaneFlagConfigKey } from "@splitch/contracts";
import { envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ConfigStoreDeps, type ConfigStoreWriter, makeConfigStore } from "../src/config-store";
import { type Harness, ids } from "../src/config-store-harness-core";
import { makeDurableSnapshotRevisionAllocator } from "../src/config-store-snapshot-revision";
import { makePoolHarness } from "./config-store-pool-harness";

let h: Harness;

beforeEach(async () => {
  h = await makePoolHarness();
});

afterEach(async () => {
  await h.dispose();
});

describe("Flag Configuration snapshot write order", () => {
  it("keeps the later write after an earlier write paused with stale content", async () => {
    const store = makeStore(durableRevisionAllocator());
    expect(await store.resyncFlagConfig(configIdentity())).toMatchObject({ ok: true });
    const paused = pauseFirstSnapshotCaptureAfterConfigCommit();

    const first = store.writeFlagConfig(writeInput(true));
    await paused.paused;
    const second = store.writeFlagConfig(writeInput(false));

    expect(await settlesWithin(second, 500)).toBe(false);
    paused.release();
    expect(await first).toMatchObject({ ok: true, snapshotRevision: 2 });
    expect(await second).toMatchObject({
      ok: true,
      snapshotRevision: 3,
      config: { enabled: false, version: 3 },
    });
    expect(JSON.parse(await requiredSnapshot())).toMatchObject({
      revision: 3,
      state: "present",
      data: { enabled: false, version: 3 },
    });
  });

  it("keeps a write after a repair paused with stale content", async () => {
    const store = makeStore(durableRevisionAllocator());
    expect(await store.resyncFlagConfig(configIdentity())).toMatchObject({ ok: true });
    const paused = pauseNextSnapshotCapture();

    const repair = store.repairFlagConfigSnapshot(configIdentity());
    await paused.paused;
    const write = store.writeFlagConfig(writeInput(true));

    expect(await settlesWithin(write, 500)).toBe(false);
    paused.release();
    expect(await repair).toMatchObject({
      ok: true,
      snapshotRevision: 2,
      config: { enabled: false, version: 1 },
    });
    expect(await write).toMatchObject({
      ok: true,
      snapshotRevision: 3,
      config: { enabled: true, version: 2 },
    });
    expect(JSON.parse(await requiredSnapshot())).toMatchObject({
      revision: 3,
      state: "present",
      data: { enabled: true, version: 2 },
    });
  });

  it("emits a distinct operator error when a deletion fence refuses a snapshot write", async () => {
    const nextSnapshotRevision = durableRevisionAllocator();
    const baseline = makeStore(nextSnapshotRevision);
    expect(await baseline.resyncFlagConfig(configIdentity())).toMatchObject({ ok: true });
    expect(await nextSnapshotRevision({ flagId: ids.flagId, operation: "delete" })).toBe(2);
    const error = vi.fn();
    const store = makeStore(nextSnapshotRevision, error);

    expect(await store.writeFlagConfig(writeInput(true))).toEqual({
      ok: false,
      reason: "FLAG_NOT_FOUND",
    });
    expect(error).toHaveBeenCalledWith(
      "config_store_deleted_snapshot_write_refused",
      expect.objectContaining({ flagId: ids.flagId, cause: expect.anything() }),
    );
    expect(
      await h.repo.flags.getFlagConfig(envScope(ids.appId, ids.environmentId), ids.flagId),
    ).toMatchObject({ enabled: true, version: 2 });
    expect(JSON.parse(await requiredSnapshot())).toMatchObject({
      revision: 1,
      state: "present",
      data: { enabled: false, version: 1 },
    });
  });
});

function makeStore(
  nextSnapshotRevision: ConfigStoreDeps["nextSnapshotRevision"],
  error: (...args: unknown[]) => void = console.error,
): ConfigStoreWriter {
  return makeConfigStore({
    repo: h.repo,
    kv: h.kv,
    broadcaster: { broadcast: () => undefined },
    nextSnapshotRevision,
    logger: { error, warn: console.warn },
  });
}

function configIdentity() {
  return { appId: ids.appId, environmentId: ids.environmentId, flagId: ids.flagId };
}

function writeInput(enabled: boolean) {
  return {
    ...configIdentity(),
    enabled,
    actor: { ref: "user_spl_526", via: "session" } as const,
  };
}

async function requiredSnapshot(): Promise<string> {
  const key = controlPlaneFlagConfigKey(ids.appId, ids.environmentId, ids.flagId);
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

function pauseFirstSnapshotCaptureAfterConfigCommit() {
  let canArm = true;
  let shouldPause = false;
  const updateFlagConfig = h.repo.flags.updateFlagConfig;
  h.repo.flags.updateFlagConfig = async (...args) => {
    const result = await updateFlagConfig(...args);
    if (result && canArm) {
      canArm = false;
      shouldPause = true;
    }
    return result;
  };
  return pauseSnapshotCapture(
    () => shouldPause,
    () => (shouldPause = false),
  );
}

function pauseNextSnapshotCapture() {
  let shouldPause = true;
  return pauseSnapshotCapture(
    () => shouldPause,
    () => (shouldPause = false),
  );
}

function pauseSnapshotCapture(shouldPause: () => boolean, disarm: () => void) {
  const deferred = gate();
  const getFlagConfig = h.repo.flags.getFlagConfig;
  h.repo.flags.getFlagConfig = async (...args) => {
    const captured = await getFlagConfig(...args);
    if (shouldPause()) {
      disarm();
      deferred.markPaused();
      await deferred.wait;
    }
    return captured;
  };
  return { paused: deferred.paused, release: deferred.release };
}

async function settlesWithin<T>(promise: Promise<T>, milliseconds: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), milliseconds)),
  ]);
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
