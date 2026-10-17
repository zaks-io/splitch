import { env, runInDurableObject } from "cloudflare:test";
import {
  activationConfigKey,
  clientKeyCacheKey,
  controlPlaneFlagConfigKey,
  credentialRevocationCacheKey,
  flagConfigKey,
  TERMINAL_CREDENTIAL_REVOCATION_MARKER,
} from "@splitch/contracts";
import { appScope, envScope } from "@splitch/db";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppEnvironmentDeps } from "../src/app-environment-model";
import { makeConfigStore } from "../src/config-store";
import { durableConfigStoreAccess } from "../src/config-store-access";
import { makeSnapshotRevisionCounter } from "../src/config-store-fixture-data";
import { type Harness, ids, NOW, NOW_MS } from "../src/config-store-harness-core";
import type { ControlPlaneFlagConfigSnapshot } from "../src/config-store-kv";
import { makeConfigStoreProjectionJournalFixture } from "../src/config-store-projection-journal-fixture";
import { sha256Hex } from "../src/credential-cache";
import { teardownTemporaryEnvironment } from "../src/temporary-environment-teardown";
import { makePoolHarness } from "./config-store-pool-harness";

let h: Harness;
let deps: AppEnvironmentDeps;
let state: Map<string, string>;
let projectionJournal: ReturnType<typeof makeConfigStoreProjectionJournalFixture>;
const scope = envScope(ids.appId, ids.devEnvironmentId);
const input = {
  appId: ids.appId,
  environmentId: ids.devEnvironmentId,
  actorId: "user_teardown",
  orgId: ids.orgId,
  requestId: "req_teardown",
};

beforeEach(async () => {
  h = await makePoolHarness();
  await h.d1
    .prepare(
      "UPDATE environments SET expires_at = ?, synced_from_environment_id = 'env_prod', synced_at = '2026-07-01T20:00:00.000Z' WHERE id = ?",
    )
    .bind("2026-07-02T20:00:00.000Z", input.environmentId)
    .run();
  await h.repo.credentials.clientKeys.insert(scope, {
    keyId: "ck_temporary_teardown",
    appId: ids.appId,
    environmentId: input.environmentId,
    keyMaterial: "pk_temporary_teardown_fixture",
    createdAt: NOW,
  });
  state = new Map([["control-plane-snapshot-revision", "10"]]);
  projectionJournal = makeConfigStoreProjectionJournalFixture();
  const writer = makeConfigStore({
    projectionJournal,
    repo: h.repo,
    kv: h.kv,
    broadcaster: { broadcast() {} },
    nextSnapshotRevision: makeSnapshotRevisionCounter(),
    now: () => new Date(NOW_MS),
    clearEnvironmentState: async () => {
      state.clear();
      projectionJournal.clear();
    },
  });
  await writer.resyncFlagConfig({ ...input, flagId: ids.flagId });
  deps = {
    repo: h.repo,
    credentialStore: env.CREDENTIAL_STORE,
    nowIso: () => NOW,
    configStore: { writerFor: () => writer } as AppEnvironmentDeps["configStore"],
    exposureStatusCleanup: {
      delete: async () => {
        expect(await h.repo.credentials.listClientKeys(scope)).toEqual([]);
        expect(
          await h.kv.get(flagConfigKey(ids.appId, input.environmentId, ids.flagKey)),
        ).toBeNull();
        expect(await h.repo.flags.getFlagConfig(scope, ids.flagId)).not.toBeNull();
      },
    },
  };
});
afterEach(() => vi.restoreAllMocks());

it.each(["fence", "credentials", "config-kv", "durable-state", "exposure", "d1"])(
  "resumes after a failure in %s with the row manifest retained",
  async (step) => {
    const writer = deps.configStore?.writerFor(input.appId, input.environmentId);
    if (!writer || !deps.exposureStatusCleanup) throw new Error("teardown fixture missing");
    if (step === "fence") {
      const original = writer.fenceTemporaryEnvironment.bind(writer);
      vi.spyOn(writer, "fenceTemporaryEnvironment").mockImplementationOnce(async (value) => {
        await original(value);
        throw new Error("injected fence failure");
      });
    } else if (step === "credentials") {
      const put = env.CREDENTIAL_STORE.put.bind(env.CREDENTIAL_STORE);
      vi.spyOn(env.CREDENTIAL_STORE, "put").mockImplementationOnce(async (...args) => {
        await put(...args);
        throw new Error("injected credential KV failure");
      });
    } else if (step === "config-kv") {
      const remove = h.kv.delete.bind(h.kv);
      vi.spyOn(h.kv, "delete").mockImplementationOnce(async (key) => {
        await remove(key);
        throw new Error("injected config KV failure");
      });
    } else if (step === "durable-state") {
      vi.spyOn(state, "clear").mockImplementationOnce(() => {
        throw new Error("injected state failure");
      });
    } else if (step === "exposure") {
      vi.spyOn(deps.exposureStatusCleanup, "delete").mockRejectedValueOnce(
        new Error("injected Exposure failure"),
      );
    } else {
      vi.spyOn(h.repo.identity, "deleteTemporaryEnvironmentData").mockRejectedValueOnce(
        new Error("injected D1 failure"),
      );
    }
    await expect(teardownTemporaryEnvironment(deps, input)).rejects.toThrow("injected");
    expect(
      await h.repo.identity.getEnvironment(appScope(ids.appId), input.environmentId),
    ).toMatchObject({ expiresAt: NOW });
    expect(await h.repo.flags.getFlagConfig(scope, ids.flagId)).not.toBeNull();
    await teardownTemporaryEnvironment(deps, input);
    expect(
      await h.repo.identity.getEnvironment(appScope(ids.appId), input.environmentId),
    ).toBeNull();
    expect(await h.repo.flags.getFlagConfig(scope, ids.flagId)).toBeNull();
    expect(await h.repo.flags.listTargetingRules(scope, ids.flagId)).toEqual([]);
    expect(await h.repo.credentials.listClientKeys(scope)).toEqual([]);
    expect(
      await h.kv.get(controlPlaneFlagConfigKey(ids.appId, input.environmentId, ids.flagId)),
    ).toBeNull();
    expect(state.size).toBe(0);
    const key = clientKeyCacheKey(await sha256Hex("pk_temporary_teardown_fixture"));
    expect(await env.CREDENTIAL_STORE.get(credentialRevocationCacheKey(key))).toBe(
      TERMINAL_CREDENTIAL_REVOCATION_MARKER,
    );
    deps.exposureStatusCleanup = { delete: async () => {} };
    await expect(teardownTemporaryEnvironment(deps, input)).resolves.toBeUndefined();
  },
);

it("keeps the D1 manifest and rules when the final row deletion fails", async () => {
  await h.d1
    .prepare(`CREATE TRIGGER temporary_teardown_abort BEFORE DELETE ON environments
    WHEN OLD.id = '${ids.devEnvironmentId}' BEGIN SELECT RAISE(ABORT, 'teardown test'); END;`)
    .run();
  try {
    await expect(teardownTemporaryEnvironment(deps, input)).rejects.toThrow("teardown test");
    expect(await h.repo.flags.getFlagConfig(scope, ids.flagId)).not.toBeNull();
    expect(await h.repo.flags.listTargetingRules(scope, ids.flagId)).toHaveLength(1);
    expect(
      await h.repo.identity.getEnvironment(appScope(ids.appId), input.environmentId),
    ).not.toBeNull();
  } finally {
    await h.d1.exec("DROP TRIGGER temporary_teardown_abort");
  }
  await teardownTemporaryEnvironment(deps, input);
  expect(await h.repo.identity.getEnvironment(appScope(ids.appId), input.environmentId)).toBeNull();
});

it("removes real Config Store Durable Object revision state and prevents resurrection", async () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  await h.d1
    .prepare(
      "UPDATE environments SET expires_at = ?, synced_from_environment_id = 'env_prod', synced_at = '2026-07-01T20:00:00.000Z' WHERE id = ?",
    )
    .bind(future, input.environmentId)
    .run();
  const stub = env.CONFIG_STORE_WRITER.getByName(`${ids.appId}:${input.environmentId}`);
  expect(await stub.resyncFlagConfig({ ...input, flagId: ids.flagId })).toMatchObject({ ok: true });
  await runInDurableObject(stub, async (_instance, ctx) => {
    await ctx.storage.put("control-plane-snapshot-revision", 8);
    await ctx.storage.put(`control-plane-snapshot-state:${ids.flagId}`, "present");
  });
  deps.configStore = durableConfigStoreAccess(env.CONFIG_STORE_WRITER, h.kv);
  deps.nowIso = () => new Date().toISOString();
  await teardownTemporaryEnvironment(deps, input);
  const entries = await runInDurableObject(
    stub,
    async (_instance, ctx) => (await ctx.storage.list()).size,
  );
  expect(entries).toBe(0);
  expect(
    await stub.resyncFlagConfig({
      ...input,
      flagId: ids.flagId,
      initialConfig: { defaultVariantId: ids.controlVariantId },
    }),
  ).toEqual({ ok: false, reason: "ENVIRONMENT_NOT_FOUND" });
  expect(await h.repo.flags.getFlagConfig(scope, ids.flagId)).toBeNull();
});

it.each(["expired", "missing"])(
  "a delayed Flag removal leaves no KV, Durable Object, or local state for an %s Environment",
  async (environmentState) => {
    await h.d1
      .prepare("UPDATE environments SET expires_at = ? WHERE id = ?")
      .bind(new Date(Date.now() + 60_000).toISOString(), input.environmentId)
      .run();
    const writeThrough = new Map<string, ControlPlaneFlagConfigSnapshot>();
    const access = durableConfigStoreAccess(env.CONFIG_STORE_WRITER, h.kv, { writeThrough });
    const writer = access.writerFor(input.appId, input.environmentId);
    expect(await writer.resyncFlagConfig({ ...input, flagId: ids.flagId })).toMatchObject({
      ok: true,
    });
    const key = controlPlaneFlagConfigKey(input.appId, input.environmentId, ids.flagId);
    const local = writeThrough.get(key);
    if (!local) throw new Error("expected a local write-through snapshot");
    await writer.fenceTemporaryEnvironment({ ...input, now: new Date().toISOString() });
    await writer.teardownTemporaryEnvironment(input);
    await h.repo.flags.removeTargetingRules(scope, ids.flagId);
    await h.repo.flags.removeFlagConfig(scope, ids.flagId);
    if (environmentState === "missing") {
      await teardownTemporaryEnvironment(
        { ...deps, configStore: access, exposureStatusCleanup: { delete: async () => {} } },
        input,
      );
    }
    writeThrough.set(key, local);

    expect(
      await writer.deleteFlagConfig({ ...input, flagId: ids.flagId, experimentIds: [] }),
    ).toMatchObject({ ok: true, snapshotRevision: null });

    expect(writeThrough.size).toBe(0);
    expect(await h.kv.get(key)).toBeNull();
    expect(await h.kv.get(flagConfigKey(input.appId, input.environmentId, ids.flagKey))).toBeNull();
    expect(await h.kv.get(activationConfigKey(input.appId, input.environmentId))).toBeNull();
    const stub = env.CONFIG_STORE_WRITER.getByName(`${input.appId}:${input.environmentId}`);
    expect(
      await runInDurableObject(stub, async (_instance, ctx) => (await ctx.storage.list()).size),
    ).toBe(0);
  },
);
