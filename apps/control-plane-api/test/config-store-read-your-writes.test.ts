import { envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ConfigStoreDeps, type ConfigStoreWriter, makeConfigStore } from "../src/config-store";
import {
  type ConfigStoreAccess,
  type ConfigStoreDurableObjectNamespace,
  durableConfigStoreAccess,
} from "../src/config-store-access";
import { makeSnapshotRevisionCounter } from "../src/config-store-fixture-data";
import {
  type Harness,
  ids,
  makeAuthedApp,
  NOW,
  startSeededExperiment,
  token,
} from "../src/config-store-harness-core";
import {
  type ControlPlaneFlagConfigSnapshot,
  controlPlaneFlagConfigKey,
} from "../src/config-store-kv";
import { makeDurableSnapshotRevisionAllocator } from "../src/config-store-snapshot-revision";
import { makePoolHarness } from "./config-store-pool-harness";

let h: Harness;

beforeEach(async () => {
  h = await makePoolHarness();
});

afterEach(async () => {
  await h.dispose();
});

describe("flag_config_get read-your-writes", () => {
  it("keeps a Flag Configuration write exact while another colo may serve its prior revision", async () => {
    const revisions = makeSnapshotRevisionCounter();
    const store = makeStore(revisions);
    expect(await store.resyncFlagConfig(configIdentity())).toMatchObject({ ok: true });
    const key = controlPlaneFlagConfigKey(scope(), ids.flagId);
    const previous = await requiredSnapshot(key);
    const staleKv = staleSnapshotKv(h.kv, key, previous);
    const writeThrough = new Map();
    const writeAccess = accessFor(store, staleKv, writeThrough);

    const patch = await patchFlagConfig(writeAccess, true);
    expect(patch.status).toBe(200);
    expect(await patch.json()).toMatchObject({ enabled: true, version: 2 });

    const exact = await getFlagConfig(accessFor(store, staleKv, writeThrough));
    expect(exact.status).toBe(200);
    expect(await exact.json()).toMatchObject({ enabled: true, version: 2 });

    const eventual = await getFlagConfig(accessFor(store, staleKv, new Map()));
    expect(eventual.status).toBe(200);
    expect(await eventual.json()).toMatchObject({ enabled: false, version: 1 });

    const converged = await getFlagConfig(accessFor(store, h.kv, writeThrough));
    expect(converged.status).toBe(200);
    expect(await converged.json()).toMatchObject({ enabled: true, version: 2 });
    expect(writeThrough.size).toBe(0);
  });

  it("keeps Experiment Start and End exact when KV serves the prior equal-version snapshot", async () => {
    const revisions = makeSnapshotRevisionCounter();
    const store = makeStore(revisions);
    expect(await store.resyncFlagConfig(configIdentity())).toMatchObject({ ok: true });
    const key = controlPlaneFlagConfigKey(scope(), ids.flagId);
    const draft = await requiredSnapshot(key);
    const writeThrough = new Map();

    await startSeededExperiment(h.d1);
    const startAccess = accessFor(store, staleSnapshotKv(h.kv, key, draft), writeThrough);
    expect(
      await startAccess.writerFor(ids.appId, ids.environmentId).syncExperimentConfig({
        appId: ids.appId,
        environmentId: ids.environmentId,
        experimentId: ids.experimentId,
      }),
    ).toMatchObject({ ok: true, snapshotRevision: 2 });
    const started = await getFlagConfig(startAccess);
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({
      version: 1,
      experiment: { id: ids.experimentId, name: "Checkout experiment" },
    });

    const running = await requiredSnapshot(key);
    const current = await h.repo.experiments.getExperiment(
      envScope(ids.appId, ids.environmentId),
      ids.experimentId,
    );
    if (!current) throw new Error("test Experiment is missing");
    await h.repo.experiments.updateExperiment(
      envScope(ids.appId, ids.environmentId),
      ids.experimentId,
      { status: "ended", liveRunId: null, updatedAt: NOW },
      current.liveRunId,
    );

    const endAccess = accessFor(store, staleSnapshotKv(h.kv, key, running), writeThrough);
    expect(
      await endAccess.writerFor(ids.appId, ids.environmentId).syncExperimentConfig({
        appId: ids.appId,
        environmentId: ids.environmentId,
        experimentId: ids.experimentId,
      }),
    ).toMatchObject({ ok: true, snapshotRevision: 3 });
    const ended = await getFlagConfig(endAccess);
    expect(ended.status).toBe(200);
    expect(await ended.json()).toMatchObject({ version: 1, experiment: null });
  });

  it("keeps a delete tombstone authoritative until KV confirms it", async () => {
    const revisions = makeSnapshotRevisionCounter();
    const store = makeStore(revisions);
    expect(await store.resyncFlagConfig(configIdentity())).toMatchObject({ ok: true });
    const key = controlPlaneFlagConfigKey(scope(), ids.flagId);
    const present = await requiredSnapshot(key);
    const writeThrough = new Map();
    const staleAccess = accessFor(store, staleSnapshotKv(h.kv, key, present), writeThrough);
    await h.repo.flags.removeFlagConfig(envScope(ids.appId, ids.environmentId), ids.flagId);

    expect(
      await staleAccess.writerFor(ids.appId, ids.environmentId).deleteFlagConfig(configIdentity()),
    ).toMatchObject({ ok: true, snapshotRevision: 2 });
    expect((await getFlagConfig(staleAccess)).status).toBe(404);

    const convergedAccess = accessFor(store, h.kv, writeThrough);
    expect((await getFlagConfig(convergedAccess)).status).toBe(404);
    expect(writeThrough.size).toBe(0);
  });

  it("refuses stale-null repair after another isolate records a delete", async () => {
    const store = makeStore(durableRevisionAllocator());
    expect(await store.resyncFlagConfig(configIdentity())).toMatchObject({ ok: true });
    const key = controlPlaneFlagConfigKey(scope(), ids.flagId);
    await h.repo.flags.removeFlagConfig(envScope(ids.appId, ids.environmentId), ids.flagId);

    expect(await store.deleteFlagConfig(configIdentity())).toMatchObject({
      ok: true,
      snapshotRevision: 2,
    });
    const otherIsolate = accessFor(store, missingSnapshotKv(h.kv, key), new Map());
    expect((await getFlagConfig(otherIsolate)).status).toBe(404);
    expect(JSON.parse(await requiredSnapshot(key))).toMatchObject({
      revision: 2,
      state: "deleted",
    });
  });
});

function makeStore(
  nextSnapshotRevision: ConfigStoreDeps["nextSnapshotRevision"],
): ConfigStoreWriter {
  return makeConfigStore({
    repo: h.repo,
    kv: h.kv,
    broadcaster: { broadcast: () => undefined },
    nextSnapshotRevision,
  });
}

function accessFor(
  writer: ConfigStoreWriter,
  kv: KVNamespace,
  writeThrough: Map<string, ControlPlaneFlagConfigSnapshot>,
): ConfigStoreAccess {
  const expectedName = `${ids.appId}:${ids.environmentId}`;
  const namespace = {
    getByName(name: string) {
      expect(name).toBe(expectedName);
      return writer;
    },
  } as unknown as ConfigStoreDurableObjectNamespace;
  return durableConfigStoreAccess(namespace, kv, { writeThrough });
}

async function getFlagConfig(access: ConfigStoreAccess): Promise<Response> {
  return appFor(access).request(
    `/apps/${ids.appId}/envs/${ids.environmentId}/flags/${ids.flagId}/config`,
    { headers: { authorization: `Bearer ${await token(h.signer)}` } },
  );
}

async function patchFlagConfig(access: ConfigStoreAccess, enabled: boolean): Promise<Response> {
  return appFor(access).request(
    `/apps/${ids.appId}/envs/${ids.environmentId}/flags/${ids.flagId}/config`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${await token(h.signer)}`,
        "content-type": "application/json",
        "idempotency-key": "idem_spl_526_write_through",
      },
      body: JSON.stringify({
        enabled,
        idempotency_key: "idem_spl_526_write_through",
      }),
    },
  );
}

function appFor(access: ConfigStoreAccess) {
  const writer = access.writerFor(ids.appId, ids.environmentId);
  return makeAuthedApp(
    { repo: h.repo, signer: h.signer },
    { ...writer, readFlagConfig: access.readFlagConfig },
  );
}

async function requiredSnapshot(key: string): Promise<string> {
  const snapshot = await h.kv.get(key, "text");
  if (snapshot === null) throw new Error(`test snapshot is missing: ${key}`);
  return snapshot;
}

function configIdentity() {
  return { appId: ids.appId, environmentId: ids.environmentId, flagId: ids.flagId };
}

function scope() {
  return { appId: ids.appId, environmentId: ids.environmentId } as const;
}

function staleSnapshotKv(base: KVNamespace, key: string, stale: string): KVNamespace {
  return new Proxy(base, {
    get(target, property) {
      if (property === "get") {
        return async (requestedKey: string, ...args: unknown[]) =>
          requestedKey === key ? stale : target.get(requestedKey, ...(args as ["text"]));
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function missingSnapshotKv(base: KVNamespace, key: string): KVNamespace {
  return new Proxy(base, {
    get(target, property) {
      if (property === "get") {
        return async (requestedKey: string, ...args: unknown[]) =>
          requestedKey === key ? null : target.get(requestedKey, ...(args as ["text"]));
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
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
