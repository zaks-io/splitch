import { CURRENT_KV_SCHEMA_VERSION } from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeConfigStore, type ConfigStoreWriter } from "../src/config-store";
import {
  durableConfigStoreAccess,
  type ConfigStoreAccess,
  type ConfigStoreDurableObjectNamespace,
} from "../src/config-store-access";
import { controlPlaneFlagConfigKey } from "../src/config-store-kv";
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
  it("issues zero D1 queries and zero DO subrequests on a warm read", async () => {
    const seeded = makeConfigStore({
      repo: h.repo,
      kv: h.kv,
      broadcaster: { broadcast: () => undefined },
    });
    expect(await seeded.resyncFlagConfig(configIdentity())).toMatchObject({ ok: true });

    const counted = countingD1(h.d1);
    const repo = createRepository(counted.db);
    const target = namespaceFor(
      makeConfigStore({ repo, kv: h.kv, broadcaster: { broadcast: () => undefined } }),
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
    const counted = countingD1(h.d1);
    const repo = createRepository(counted.db);
    const writer = makeConfigStore({
      repo,
      kv: h.kv,
      broadcaster: { broadcast: () => undefined },
    });
    const target = namespaceFor(writer);
    const warn = vi.fn();
    const access = durableConfigStoreAccess(target.namespace, h.kv, {
      logger: { warn },
      writeThrough: new Map(),
    });
    const app = appFor(repo, access);
    const key = controlPlaneFlagConfigKey(scope(), ids.flagId);
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
      makeConfigStore({ repo, kv: h.kv, broadcaster: { broadcast: () => undefined } }),
    );
    const warn = vi.fn();
    const access = durableConfigStoreAccess(target.namespace, h.kv, {
      logger: { warn },
      writeThrough: new Map(),
    });
    const app = appFor(repo, access);
    const key = controlPlaneFlagConfigKey(scope(), ids.flagId);
    await h.kv.put(
      key,
      JSON.stringify({
        schemaVersion: CURRENT_KV_SCHEMA_VERSION,
        data: { flagId: ids.flagId, environmentId: ids.environmentId, version: "broken" },
      }),
    );
    counted.reset();
    target.reset();

    const response = await getFlagConfig(app);

    expect(response.status).toBe(500);
    expect(counted.queries()).toBe(0);
    expect(target.subrequests()).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      "config_store_kv_schema_mismatch",
      expect.objectContaining({ key, cause: expect.anything() }),
    );
    expect(await h.kv.get(key, "text")).toContain('"version":"broken"');
  });

  it("keeps same-isolate reads exact while another colo may see the cached previous version", async () => {
    const store = makeConfigStore({
      repo: h.repo,
      kv: h.kv,
      broadcaster: { broadcast: () => undefined },
    });
    expect(await store.resyncFlagConfig(configIdentity())).toMatchObject({ ok: true });
    const key = controlPlaneFlagConfigKey(scope(), ids.flagId);
    const previous = await h.kv.get(key, "text");
    if (previous === null) throw new Error("test setup did not write the control-plane snapshot");

    const staleKv = staleSnapshotKv(h.kv, key, previous);
    const target = namespaceFor(store);
    const sameIsolateWriteThrough = new Map();
    const writeAccess = durableConfigStoreAccess(target.namespace, staleKv, {
      writeThrough: sameIsolateWriteThrough,
    });
    const writeApp = appFor(h.repo, writeAccess);

    const patch = await patchFlagConfig(writeApp, true);
    expect(patch.status).toBe(200);
    expect(await patch.json()).toMatchObject({ enabled: true, version: 2 });

    // A new access object represents the next request in this isolate. The shared
    // write-through wins over the stale edge KV entry and preserves the acked write.
    const nextRequestAccess = durableConfigStoreAccess(target.namespace, staleKv, {
      writeThrough: sameIsolateWriteThrough,
    });
    const exact = await getFlagConfig(appFor(h.repo, nextRequestAccess));
    expect(exact.status).toBe(200);
    expect(await exact.json()).toMatchObject({ enabled: true, version: 2 });

    // A different colo has no isolate-local write-through. Cloudflare KV may
    // legally serve its cached previous value during the propagation window.
    const otherColoAccess = durableConfigStoreAccess(target.namespace, staleKv, {
      writeThrough: new Map(),
    });
    const eventual = await getFlagConfig(appFor(h.repo, otherColoAccess));
    expect(eventual.status).toBe(200);
    expect(await eventual.json()).toMatchObject({ enabled: false, version: 1 });

    const convergedAccess = durableConfigStoreAccess(target.namespace, h.kv, {
      writeThrough: sameIsolateWriteThrough,
    });
    const converged = await getFlagConfig(appFor(h.repo, convergedAccess));
    expect(converged.status).toBe(200);
    expect(await converged.json()).toMatchObject({ enabled: true, version: 2 });
    expect(sameIsolateWriteThrough.size).toBe(0);
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

async function patchFlagConfig(app: Harness["app"], enabled: boolean): Promise<Response> {
  return app.request(flagConfigPath(), {
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
  const namespace = {
    getByName() {
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
