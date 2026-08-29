import { CURRENT_KV_SCHEMA_VERSION, flagConfigKey } from "@splitch/contracts";
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
import { controlPlaneFlagConfigKey } from "../src/config-store-kv";
import { makePoolHarness } from "./config-store-pool-harness";

let h: Harness;

beforeEach(async () => {
  h = await makePoolHarness();
});

afterEach(async () => {
  await h.dispose();
});

describe("flag_config_get direct KV reads", () => {
  it("issues zero D1 queries and zero DO subrequests on a warm read", async () => {
    const seeded = makeConfigStore({
      repo: h.repo,
      kv: h.kv,
      broadcaster: { broadcast: () => undefined },
      nextSnapshotRevision: makeSnapshotRevisionCounter(),
    });
    expect(await seeded.resyncFlagConfig(configIdentity())).toMatchObject({ ok: true });

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
    const access = durableConfigStoreAccess(target.namespace, h.kv, {
      writeThrough: new Map(),
    });
    const app = appFor(repo, access);
    counted.reset();
    target.reset();
    const authorization = `Bearer ${await token(h.signer)}`;

    const startedAt = performance.now();
    const response = await app.request(flagConfigPath(), { headers: { authorization } });
    const durationMs = performance.now() - startedAt;

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ flagId: ids.flagId, version: 1 });
    expect(counted.queries()).toBe(0);
    expect(target.subrequests()).toBe(0);
    console.info("flag_config_get_measurement", {
      path: "direct-kv-warm",
      queries: counted.queries(),
      durableObjectSubrequests: target.subrequests(),
      durationMs,
    });
  });

  it("falls back through the writer DO on a KV miss, repairs the snapshot, and logs it", async () => {
    const revisions = makeSnapshotRevisionCounter();
    const seeded = makeConfigStore({
      repo: h.repo,
      kv: h.kv,
      broadcaster: { broadcast: () => undefined },
      nextSnapshotRevision: revisions,
    });
    expect(await seeded.resyncFlagConfig(configIdentity())).toMatchObject({ ok: true });
    const key = controlPlaneFlagConfigKey(scope(), ids.flagId);
    await h.kv.delete(key);
    expect(
      await h.kv.get(flagConfigKey(ids.appId, ids.environmentId, ids.flagKey), "text"),
    ).toEqual(expect.any(String));

    const counted = countingD1(h.d1);
    const repo = createRepository(counted.db);
    const writer = makeConfigStore({
      repo,
      kv: h.kv,
      broadcaster: { broadcast: () => undefined },
      nextSnapshotRevision: revisions,
    });
    const target = namespaceFor(writer);
    const warn = vi.fn();
    const access = durableConfigStoreAccess(target.namespace, missingSnapshotKv(h.kv, key), {
      logger: { error: vi.fn(), warn },
      writeThrough: new Map(),
    });
    const app = appFor(repo, access);
    expect(await h.kv.get(key, "text")).toBeNull();
    counted.reset();
    target.reset();

    const response = await getFlagConfig(app);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ flagId: ids.flagId, enabled: false });
    expect(counted.queries()).toBeGreaterThan(0);
    expect(target.subrequests()).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      "config_store_kv_snapshot_miss",
      expect.objectContaining({
        appId: ids.appId,
        environmentId: ids.environmentId,
        flagId: ids.flagId,
      }),
    );
    expect(await h.kv.get(key, "text")).toEqual(expect.any(String));

    counted.reset();
    target.reset();
    expect((await getFlagConfig(app)).status).toBe(200);
    expect(counted.queries()).toBe(0);
    expect(target.subrequests()).toBe(0);
  });

  it("fails loud on a malformed control-plane snapshot without a DO or D1 fallback", async () => {
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
    const error = vi.fn();
    const access = durableConfigStoreAccess(target.namespace, h.kv, {
      logger: { error, warn: vi.fn() },
      writeThrough: new Map(),
    });
    const app = appFor(repo, access);
    const key = controlPlaneFlagConfigKey(scope(), ids.flagId);
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
    counted.reset();
    target.reset();

    const response = await getFlagConfig(app);

    expect(response.status).toBe(500);
    expect(counted.queries()).toBe(0);
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

function scope() {
  return { appId: ids.appId, environmentId: ids.environmentId } as const;
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
