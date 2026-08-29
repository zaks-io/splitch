import {
  CURRENT_KV_SCHEMA_VERSION,
  controlPlaneFlagConfigKey,
  flagConfigKey,
} from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ConfigStoreWriter, makeConfigStore } from "../src/config-store";
import {
  type ConfigStoreAccess,
  type ConfigStoreDurableObjectNamespace,
  durableConfigStoreAccess,
} from "../src/config-store-access";
import { makeSnapshotRevisionCounter } from "../src/config-store-fixture-data";
import { type Harness, ids, makeAuthedApp, token } from "../src/config-store-harness-core";
import { makePoolHarness } from "./config-store-pool-harness";

let h: Harness;

beforeEach(async () => {
  h = await makePoolHarness();
});

afterEach(async () => {
  await h.dispose();
});

describe("flag_config_get direct KV reads", () => {
  it("issues zero config-store D1 queries and zero DO subrequests on a warm read", async () => {
    const seeded = makeConfigStore({
      repo: h.repo,
      kv: h.kv,
      broadcaster: { broadcast: () => undefined },
      nextSnapshotRevision: makeSnapshotRevisionCounter(),
    });
    expect(await seeded.resyncFlagConfig(configIdentity())).toMatchObject({ ok: true });

    const resolverD1 = countingD1(h.d1);
    const configStoreD1 = countingD1(h.d1);
    const repo = createRepository(resolverD1.db);
    const configStoreRepo = createRepository(configStoreD1.db);
    const target = namespaceFor(
      makeConfigStore({
        repo: configStoreRepo,
        kv: h.kv,
        broadcaster: { broadcast: () => undefined },
        nextSnapshotRevision: makeSnapshotRevisionCounter(),
      }),
    );
    const access = durableConfigStoreAccess(target.namespace, h.kv, {
      repo: configStoreRepo,
      waitUntil: (promise) => void promise,
      writeThrough: new Map(),
    });
    const app = appFor(repo, access);
    resolverD1.reset();
    configStoreD1.reset();
    target.reset();
    const authorization = `Bearer ${await token(h.signer)}`;

    const startedAt = performance.now();
    const response = await app.request(flagConfigPath(), { headers: { authorization } });
    const durationMs = performance.now() - startedAt;

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ flagId: ids.flagId, version: 1 });
    // SPL-524 checks for legacy Environment-key collisions; SPL-541 removes the duplicate read.
    expect(resolverD1.queries()).toBe(1);
    expect(configStoreD1.queries()).toBe(0);
    expect(target.subrequests()).toBe(0);
    console.info("flag_config_get_measurement", {
      path: "direct-kv-warm",
      resolverD1Queries: resolverD1.queries(),
      configStoreD1Queries: configStoreD1.queries(),
      durableObjectSubrequests: target.subrequests(),
      durationMs,
    });
  });
});

describe("flag_config_get KV miss reads", () => {
  it("reads D1 directly on a KV miss and repairs the snapshot in waitUntil", async () => {
    const revisions = makeSnapshotRevisionCounter();
    const seeded = makeConfigStore({
      repo: h.repo,
      kv: h.kv,
      broadcaster: { broadcast: () => undefined },
      nextSnapshotRevision: revisions,
    });
    expect(await seeded.resyncFlagConfig(configIdentity())).toMatchObject({ ok: true });
    const key = controlPlaneFlagConfigKey(ids.appId, ids.environmentId, ids.flagId);
    await h.kv.delete(key);
    expect(
      await h.kv.get(flagConfigKey(ids.appId, ids.environmentId, ids.flagKey), "text"),
    ).toEqual(expect.any(String));

    const resolverD1 = countingD1(h.d1);
    const configStoreD1 = countingD1(h.d1);
    const repo = createRepository(resolverD1.db);
    const configStoreRepo = createRepository(configStoreD1.db);
    const writer = makeConfigStore({
      repo: configStoreRepo,
      kv: h.kv,
      broadcaster: { broadcast: () => undefined },
      nextSnapshotRevision: revisions,
    });
    const target = namespaceFor(writer);
    const warn = vi.fn();
    const backgroundTasks: Promise<unknown>[] = [];
    const access = durableConfigStoreAccess(target.namespace, missingSnapshotKv(h.kv, key), {
      logger: { error: vi.fn(), warn },
      repo: configStoreRepo,
      waitUntil: (promise) => {
        backgroundTasks.push(promise);
      },
      writeThrough: new Map(),
    });
    const app = appFor(repo, access);
    expect(await h.kv.get(key, "text")).toBeNull();
    resolverD1.reset();
    configStoreD1.reset();
    target.reset();

    const response = await getFlagConfig(app);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ flagId: ids.flagId, enabled: false });
    expect(resolverD1.queries()).toBe(1);
    expect(configStoreD1.queries()).toBeGreaterThan(0);
    expect(target.subrequests()).toBe(1);
    expect(backgroundTasks).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      "config_store_kv_snapshot_miss",
      expect.objectContaining({
        appId: ids.appId,
        environmentId: ids.environmentId,
        flagId: ids.flagId,
      }),
    );
    await Promise.all(backgroundTasks);
    expect(await h.kv.get(key, "text")).toEqual(expect.any(String));

    resolverD1.reset();
    configStoreD1.reset();
    target.reset();
    expect((await getFlagConfig(app)).status).toBe(200);
    // SPL-524 checks for legacy Environment-key collisions; SPL-541 removes the duplicate read.
    expect(resolverD1.queries()).toBe(1);
    expect(configStoreD1.queries()).toBe(0);
    expect(target.subrequests()).toBe(0);
  });

  it("returns FLAG_NOT_FOUND from D1 on a KV miss without touching the writer DO", async () => {
    const counted = countingD1(h.d1);
    const repo = createRepository(counted.db);
    const target = namespaceFor(
      makeConfigStore({
        repo,
        kv: h.kv,
        broadcaster: { broadcast: () => undefined },
        nextSnapshotRevision: makeSnapshotRevisionCounter(),
      }),
    );
    const backgroundTasks: Promise<unknown>[] = [];
    const access = durableConfigStoreAccess(target.namespace, h.kv, {
      repo,
      waitUntil: (promise) => {
        backgroundTasks.push(promise);
      },
      writeThrough: new Map(),
    });
    const app = appFor(repo, access);
    counted.reset();
    target.reset();

    const response = await app.request(
      `/apps/${ids.appId}/envs/${ids.environmentId}/flags/flag_missing/config`,
      { headers: { authorization: `Bearer ${await token(h.signer)}` } },
    );

    expect(response.status).toBe(404);
    expect(counted.queries()).toBeGreaterThan(0);
    expect(target.subrequests()).toBe(0);
    expect(backgroundTasks).toHaveLength(0);
  });
});

describe("flag_config_get snapshot failures", () => {
  it("fails loud on a malformed snapshot without a DO or config-store D1 fallback", async () => {
    const resolverD1 = countingD1(h.d1);
    const configStoreD1 = countingD1(h.d1);
    const repo = createRepository(resolverD1.db);
    const configStoreRepo = createRepository(configStoreD1.db);
    const target = namespaceFor(
      makeConfigStore({
        repo: configStoreRepo,
        kv: h.kv,
        broadcaster: { broadcast: () => undefined },
        nextSnapshotRevision: makeSnapshotRevisionCounter(),
      }),
    );
    const error = vi.fn();
    const access = durableConfigStoreAccess(target.namespace, h.kv, {
      logger: { error, warn: vi.fn() },
      repo: configStoreRepo,
      waitUntil: (promise) => void promise,
      writeThrough: new Map(),
    });
    const app = appFor(repo, access);
    const key = controlPlaneFlagConfigKey(ids.appId, ids.environmentId, ids.flagId);
    await h.kv.put(
      key,
      JSON.stringify({
        schemaVersion: CURRENT_KV_SCHEMA_VERSION,
        appId: ids.appId,
        environmentId: ids.environmentId,
        flagId: ids.flagId,
        revision: 1,
        state: "present",
        data: { flagId: ids.flagId, environmentId: ids.environmentId, version: "broken" },
      }),
    );
    resolverD1.reset();
    configStoreD1.reset();
    target.reset();

    const response = await getFlagConfig(app);

    expect(response.status).toBe(500);
    // SPL-524 checks for legacy Environment-key collisions; SPL-541 removes the duplicate read.
    expect(resolverD1.queries()).toBe(1);
    expect(configStoreD1.queries()).toBe(0);
    expect(target.subrequests()).toBe(0);
    expect(error).toHaveBeenCalledWith(
      "config_store_kv_schema_mismatch",
      expect.objectContaining({ key, cause: expect.anything() }),
    );
    expect(await h.kv.get(key, "text")).toContain('"version":"broken"');
  });
});

function appFor(repo: Harness["repo"], access: ConfigStoreAccess) {
  const writer = access.writerFor(ids.appId, ids.environmentId);
  const routedStore = {
    ...writer,
    readFlagConfig: access.readFlagConfig,
  } satisfies ConfigStoreWriter;
  return makeAuthedApp({ repo, signer: h.signer }, routedStore);
}

async function getFlagConfig(app: Harness["app"]): Promise<Response> {
  return app.request(flagConfigPath(), {
    headers: { authorization: `Bearer ${await token(h.signer)}` },
  });
}

function flagConfigPath(): string {
  return `/apps/${ids.appId}/envs/${ids.environmentId}/flags/${ids.flagId}/config`;
}

function configIdentity() {
  return { appId: ids.appId, environmentId: ids.environmentId, flagId: ids.flagId };
}

function namespaceFor(writer: ConfigStoreWriter) {
  let calls = 0;
  const expectedName = `${ids.appId}:${ids.environmentId}`;
  const namespace = {
    getByName(name: string) {
      expect(name).toBe(expectedName);
      calls += 1;
      return writer;
    },
  } as unknown as ConfigStoreDurableObjectNamespace;
  return {
    namespace,
    subrequests: () => calls,
    reset: () => {
      calls = 0;
    },
  };
}

function missingSnapshotKv(base: KVNamespace, key: string): KVNamespace {
  return new Proxy(base, {
    get(target, property) {
      if (property === "get") {
        return async (requestedKey: string, ...args: unknown[]) => {
          if (requestedKey === key) return null;
          return (target.get as (...parameters: unknown[]) => Promise<unknown>)(
            requestedKey,
            ...args,
          );
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function countingD1(db: D1Database) {
  let calls = 0;
  const counted = new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (property === "prepare") {
        return (...args: Parameters<D1Database["prepare"]>) => {
          calls += 1;
          return target.prepare(...args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    db: counted,
    queries: () => calls,
    reset: () => {
      calls = 0;
    },
  };
}
