import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appScope, createRepository, envScope } from "../index.js";
import { createLocalD1, type LocalD1 } from "./test-d1.js";
import { seedTwoTenants, type SeededTenants } from "./test-seed.js";

/**
 * Write-side tenant-isolation breach tests (the audit-found CROSS-TENANT WRITE).
 *
 * The seam stamps the scope's app_id/environment_id onto every INSERT and forbids
 * an UPDATE from setting them. A regression where those ops key by the SQL column
 * name instead of the Drizzle property name silently no-ops both — letting App A
 * plant a row in App B (INSERT forge) or move its own row into App B (UPDATE
 * move). These tests reproduce both exploits and assert against a RAW D1 read of
 * what actually persisted, not the object the method returned.
 *
 * A fresh D1 per test keeps the forge attempts from polluting shared seed state.
 * Seeds use DISTINCT keys per tenant so the (app_id, key) UNIQUE index cannot
 * mask a move as a constraint error.
 */

let local: LocalD1;
let repo: ReturnType<typeof createRepository>;
let seed: SeededTenants;

beforeEach(async () => {
  local = await createLocalD1();
  repo = createRepository(local.d1);
  seed = await seedTwoTenants(local.d1);
});

afterEach(async () => {
  await local.dispose();
});

/** Raw, scope-free read of a flag's persisted app_id — ground truth. */
async function rawFlagAppId(local: LocalD1, flagId: string): Promise<string | null> {
  const row = await local.d1
    .prepare("SELECT app_id FROM flags WHERE id = ?")
    .bind(flagId)
    .first<{ app_id: string }>();
  return row?.app_id ?? null;
}

async function rawApiKeyEnv(
  local: LocalD1,
  keyId: string,
): Promise<{ app_id: string; environment_id: string } | null> {
  return local.d1
    .prepare("SELECT app_id, environment_id FROM api_keys WHERE key_id = ?")
    .bind(keyId)
    .first<{ app_id: string; environment_id: string }>();
}

describe("INSERT cannot be forged into another tenant", () => {
  it("a forged appId in the insert input is overridden by the issuing scope", async () => {
    const aScope = appScope(seed.a.appId);

    const returned = await repo.flags.flags.insert(aScope, {
      id: "flag_forge_attempt",
      appId: seed.b.appId, // FORGED: caller claims App B from App A's scope
      key: "flag-key-forge",
      name: "forged",
      createdAt: "2026-06-28T00:00:00.000Z",
      updatedAt: "2026-06-28T00:00:00.000Z",
    });

    // The returned object must carry App A (the issuing scope), not the forgery.
    expect(returned.appId).toBe(seed.a.appId);
    // And the PERSISTED row, read raw, must be App A's — App A did NOT plant a
    // row in App B. On the old (column.name) code this was seed.b.appId.
    expect(await rawFlagAppId(local, "flag_forge_attempt")).toBe(seed.a.appId);
  });

  it("a per-Environment insert stamps the scope's environment_id, not a forged one", async () => {
    const eScope = envScope(seed.a.appId, seed.a.environmentId);

    await repo.credentials.apiKeys.insert(eScope, {
      keyId: "key_forge_attempt",
      appId: seed.b.appId, // forged app
      environmentId: seed.b.environmentId, // forged env
      keyHash: "h",
      scopes: "[]",
      createdAt: "2026-06-28T00:00:00.000Z",
    });

    const persisted = await rawApiKeyEnv(local, "key_forge_attempt");
    expect(persisted).toEqual({
      app_id: seed.a.appId,
      environment_id: seed.a.environmentId,
    });
  });
});

describe("UPDATE cannot move a row across tenants", () => {
  it("setting app_id in an UPDATE throws (immutable scope column)", async () => {
    const aScope = appScope(seed.a.appId);

    await expect(
      // Smuggle App B's app_id into the SET of App A's OWN row. On the old code
      // the strip no-op'd and app_id=app_b flowed into SET, moving the row.
      repo.flags.flags.update(aScope, { appId: seed.b.appId, name: "moved" } as never),
    ).rejects.toThrow(/cannot set scope column "appId"/);

    // App A's row is untouched, still App A's, still its original name.
    expect(await rawFlagAppId(local, seed.a.flagId)).toBe(seed.a.appId);
  });

  it("setting environment_id in a per-Env UPDATE throws", async () => {
    const eScope = envScope(seed.a.appId, seed.a.environmentId);

    await expect(
      repo.credentials.apiKeys.update(eScope, {
        environmentId: seed.b.environmentId,
      } as never),
    ).rejects.toThrow(/cannot set scope column "environmentId"/);

    const persisted = await rawApiKeyEnv(local, seed.a.apiKeyId);
    expect(persisted).toEqual({
      app_id: seed.a.appId,
      environment_id: seed.a.environmentId,
    });
  });

  it("App B's data is untouched by App A's forge attempts", async () => {
    const aScope = appScope(seed.a.appId);
    await repo.flags.flags.update(aScope, { appId: seed.b.appId } as never).catch(() => undefined);
    // B's flag still belongs to B.
    expect(await rawFlagAppId(local, seed.b.flagId)).toBe(seed.b.appId);
  });
});

describe("a hand-forged (non-minted) scope is rejected at runtime", () => {
  it("a plain object masquerading as a scope fails loud", async () => {
    const forged = { appId: seed.b.appId } as never;
    await expect(repo.flags.getFlag(forged, seed.b.flagId)).rejects.toThrow(
      /not minted by appScope/,
    );
  });
});
