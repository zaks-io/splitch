import { env } from "cloudflare:workers";
import {
  clientKeyCacheKey,
  credentialRevocationCacheKey,
  TERMINAL_CREDENTIAL_REVOCATION_MARKER,
} from "@splitch/contracts";
import { appScope, envScope } from "@splitch/db";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { durableConfigStoreAccess } from "../src/config-store-access";
import { type Harness, ids, NOW, NOW_MS } from "../src/config-store-harness-core";
import { sha256Hex, writeClientKeyCache } from "../src/credential-cache";
import { durableCredentialCacheWriterAccess } from "../src/credential-cache-writer-do";
import type { ControlPlaneApiEnv } from "../src/env";
import { teardownTemporaryEnvironment } from "../src/temporary-environment-teardown";
import { runTemporaryEnvironmentTeardown } from "../src/temporary-environment-teardown-scheduled";
import { makePoolHarness } from "./config-store-pool-harness";

let h: Harness;
let seen: string[];
const environmentIds = Array.from({ length: 7 }, (_, i) => `env_temporary_cron_${i}`);

beforeEach(async () => {
  h = await makePoolHarness();
  seen = [];
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

async function seedExpiredEnvironments(nowMs = NOW_MS) {
  // Reverse insertion order proves the cron follows expiry rather than insertion order.
  for (const [i, id] of [...environmentIds.entries()].reverse()) {
    await h.repo.identity.environments.insert(appScope(ids.appId), {
      id,
      appId: ids.appId,
      key: `cron-${i}`,
      name: `Cron ${i}`,
      expiresAt: new Date(nowMs - (7 - i) * 60_000).toISOString(),
      syncedFromEnvironmentId: ids.environmentId,
      syncedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
}

function cronEnv(failFirst = false): ControlPlaneApiEnv {
  return {
    ...env,
    ANALYSIS_API: {
      fetch: async (request: Request) => {
        const id = new URL(request.url).searchParams.get("environmentId");
        if (!id) throw new Error("Exposure cleanup did not include its Environment");
        seen.push(id);
        return id === environmentIds[0] && failFirst
          ? new Response(null, { status: 503 })
          : Response.json({ deleted: true });
      },
    },
  } as unknown as ControlPlaneApiEnv;
}

const event = { cron: "* * * * *", scheduledTime: NOW_MS } as ScheduledController;
const ctx = {
  waitUntil: (promise: Promise<unknown>) => {
    void promise;
  },
};

it("tears down the five oldest expired rows per minute through the real D1 and DO boundaries", async () => {
  await seedExpiredEnvironments();
  await runTemporaryEnvironmentTeardown(cronEnv(), event, ctx);
  expect(seen).toEqual(environmentIds.slice(0, 5));
  expect(
    (await h.repo.identity.listExpiredTemporaryEnvironments(NOW, 10)).map((row) => row.id),
  ).toEqual(environmentIds.slice(5));
  await runTemporaryEnvironmentTeardown(cronEnv(), event, ctx);
  expect(await h.repo.identity.listExpiredTemporaryEnvironments(NOW, 10)).toEqual([]);
});

it("reports one failed manifest and still processes later rows before retrying it on the next tick", async () => {
  await seedExpiredEnvironments();
  await expect(runTemporaryEnvironmentTeardown(cronEnv(true), event, ctx)).rejects.toThrow(
    "temporary_environment_teardown_failed",
  );
  expect(seen).toEqual(environmentIds.slice(0, 5));
  expect(
    (await h.repo.identity.listExpiredTemporaryEnvironments(NOW, 10)).map((row) => row.id),
  ).toEqual([environmentIds[0], ...environmentIds.slice(5)]);
  await runTemporaryEnvironmentTeardown(cronEnv(), event, ctx);
  expect(await h.repo.identity.listExpiredTemporaryEnvironments(NOW, 10)).toEqual([]);
});

it("removes 50 Environments with the same expiry in ten minute ticks, five per tick, without older backlog", async () => {
  const batch = Array.from({ length: 50 }, (_, i) => `env_temporary_batch_${i}`);
  for (const [i, id] of batch.entries()) {
    await h.repo.identity.environments.insert(appScope(ids.appId), {
      id,
      appId: ids.appId,
      key: `batch-${i}`,
      name: `Batch ${i}`,
      expiresAt: NOW,
      syncedFromEnvironmentId: ids.environmentId,
      syncedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
  expect(await h.repo.identity.listExpiredTemporaryEnvironments(NOW, 100)).toHaveLength(50);
  for (let tick = 0; tick < 10; tick += 1) {
    const previous = seen.length;
    const scheduledTime = NOW_MS + tick * 60_000;
    await runTemporaryEnvironmentTeardown(cronEnv(), { ...event, scheduledTime }, ctx);
    expect(seen.length - previous).toBe(5);
    expect(new Set(seen).size).toBe((tick + 1) * 5);
    expect(
      await h.repo.identity.listExpiredTemporaryEnvironments(
        new Date(scheduledTime).toISOString(),
        100,
      ),
    ).toHaveLength(50 - (tick + 1) * 5);
  }
  expect([...seen].sort()).toEqual(batch.sort());
});

it("cron recovers a manual fence-before-revoke failure behind older backlog before the key's original expiry", async () => {
  const now = Date.now();
  await seedExpiredEnvironments(now);
  const originalExpiry = new Date(now + 3_600_000).toISOString();
  const environmentId = ids.devEnvironmentId;
  const scope = envScope(ids.appId, environmentId);
  await h.d1
    .prepare(
      "UPDATE environments SET expires_at = ?, synced_from_environment_id = ?, synced_at = ? WHERE id = ?",
    )
    .bind(originalExpiry, ids.environmentId, NOW, environmentId)
    .run();
  const keyRow = await h.repo.credentials.clientKeys.insert(scope, {
    keyId: "ck_manual_cron_recovery",
    appId: ids.appId,
    environmentId,
    keyMaterial: "pk_manual_cron_recovery_fixture",
    createdAt: NOW,
  });
  const credentialCacheWriter = durableCredentialCacheWriterAccess(env.CREDENTIAL_CACHE_WRITER);
  await writeClientKeyCache(
    { repo: h.repo, credentialCacheWriter },
    keyRow,
    false,
    ids.orgId,
    true,
  );
  const key = clientKeyCacheKey(await sha256Hex(keyRow.keyMaterial));
  vi.spyOn(h.repo.credentials, "listClientKeys").mockRejectedValueOnce(
    new Error("injected before revoke"),
  );
  await expect(
    teardownTemporaryEnvironment(
      {
        repo: h.repo,
        credentialStore: env.CREDENTIAL_STORE,
        credentialCacheWriter,
        configStore: durableConfigStoreAccess(env.CONFIG_STORE_WRITER, h.kv),
        exposureStatusCleanup: { delete: async () => {} },
        nowIso: () => new Date(now).toISOString(),
      },
      {
        appId: ids.appId,
        environmentId,
        orgId: ids.orgId,
        actorId: "user_manual_delete",
        requestId: "req_manual_cron",
      },
    ),
  ).rejects.toThrow("injected before revoke");
  expect(await h.repo.identity.getEnvironment(appScope(ids.appId), environmentId)).toMatchObject({
    expiresAt: new Date(now).toISOString(),
  });
  expect(JSON.parse((await env.CREDENTIAL_STORE.get(key)) ?? "null")).toMatchObject({
    data: { revoked: false, expiresAt: originalExpiry },
  });
  expect(await env.CREDENTIAL_STORE.get(credentialRevocationCacheKey(key))).toBeNull();

  await runTemporaryEnvironmentTeardown(cronEnv(), { ...event, scheduledTime: now + 60_000 }, ctx);
  expect(seen).toEqual(environmentIds.slice(0, 5));
  expect(await env.CREDENTIAL_STORE.get(credentialRevocationCacheKey(key))).toBeNull();
  expect(await h.repo.identity.getEnvironment(appScope(ids.appId), environmentId)).not.toBeNull();

  const scheduledTime = now + 120_000;
  expect(scheduledTime).toBeLessThan(Date.parse(originalExpiry));
  await runTemporaryEnvironmentTeardown(cronEnv(), { ...event, scheduledTime }, ctx);
  expect(seen).toEqual([...environmentIds, environmentId]);
  expect(await env.CREDENTIAL_STORE.get(credentialRevocationCacheKey(key))).toBe(
    TERMINAL_CREDENTIAL_REVOCATION_MARKER,
  );
  expect(await h.repo.credentials.listClientKeys(scope)).toEqual([]);
  expect(await h.repo.identity.getEnvironment(appScope(ids.appId), environmentId)).toBeNull();
});
