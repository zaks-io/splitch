import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appScope, createRepository, envScope, type TenantScope } from "../index";
import { createLocalD1, type LocalD1 } from "./test-d1";

/**
 * Scope-tampering proofs for the HIGH-severity isolation bypasses found on the
 * SPL-11 tenancy PR. D1 has no RLS, so the scope value object IS the tenant
 * boundary (ADR-0018). These prove a scope cannot be (1) hand-forged onto the
 * WRITE path, (2) mutated after minting to redirect a write to another tenant, or
 * (3) forged by lifting the authenticity marker off a legitimate scope. Every
 * assertion reads the persisted app_id / environment_id by RAW SQL — never
 * through the scoped reader, which would re-apply the filter and hide a
 * mis-stamp.
 */

const NOW = "2026-06-28T00:00:00.000Z";

// DISTINCT per-tenant key values everywhere: identical seeds across tenants can
// let an (app_id, key) UNIQUE index make a cross-tenant MOVE look "blocked" when
// it was actually a constraint collision — a known trap in this seam.
const TA = {
  orgId: "org_tamper_a",
  appId: "app_tamper_a",
  envId: "env_tamper_a",
  envKey: "env-key-tamper-a",
  flagKey: "flag-key-tamper-a",
};
const TB = {
  orgId: "org_tamper_b",
  appId: "app_tamper_b",
  envId: "env_tamper_b",
  envKey: "env-key-tamper-b",
  flagKey: "flag-key-tamper-b",
};

let local: LocalD1;
let repo: ReturnType<typeof createRepository>;

async function insertRoots(d1: D1Database, t: typeof TA): Promise<void> {
  await d1
    .prepare(
      "INSERT INTO organizations (id, name, slug, plan, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    )
    .bind(t.orgId, `org ${t.orgId}`, t.orgId, "free", NOW, NOW)
    .run();
  await d1
    .prepare(
      "INSERT INTO apps (id, organization_id, name, key, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    )
    .bind(t.appId, t.orgId, `app ${t.appId}`, t.appId, NOW, NOW)
    .run();
  // Env row inserted via the scoped seam so an EnvScope's environment_id resolves
  // against a real per-Env table for the api_keys foreign key.
  await repo.identity.environments.insert(appScope(t.appId), {
    id: t.envId,
    appId: t.appId,
    key: t.envKey,
    name: "Production",
    createdAt: NOW,
    updatedAt: NOW,
  });
}

beforeAll(async () => {
  local = await createLocalD1();
  repo = createRepository(local.d1);
  await insertRoots(local.d1, TA);
  await insertRoots(local.d1, TB);
});

afterAll(async () => {
  await local.dispose();
});

async function rawFlagAppId(flagId: string): Promise<string | null> {
  const row = await local.d1
    .prepare("SELECT app_id FROM flags WHERE id = ?")
    .bind(flagId)
    .first<{ app_id: string }>();
  return row?.app_id ?? null;
}

async function rawApiKeyScope(
  keyId: string,
): Promise<{ app_id: string; environment_id: string } | null> {
  return local.d1
    .prepare("SELECT app_id, environment_id FROM api_keys WHERE key_id = ?")
    .bind(keyId)
    .first<{ app_id: string; environment_id: string }>();
}

describe("BUG 2 — a hand-forged (unminted) scope is rejected on the WRITE path", () => {
  it("scopedTable.insert with a forged App scope throws and persists no row", async () => {
    const flagId = "flag_forged_app";
    // NO mint — just a plain object that type-asserts as a scope, claiming B's app.
    const forged = { appId: TB.appId } as unknown as TenantScope;

    await expect(
      repo.flags.flags.insert(forged, {
        id: flagId,
        appId: TA.appId,
        key: TB.flagKey,
        name: "forged",
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).rejects.toThrow(/forged scope is rejected/);

    // Raw read: nothing landed under B (or anywhere) for this id.
    expect(await rawFlagAppId(flagId)).toBeNull();
  });

  it("scopedTable.insert with a forged Env scope throws and persists no api_key", async () => {
    const keyId = "key_forged_env";
    const forged = { appId: TB.appId, environmentId: TB.envId } as unknown as TenantScope;

    await expect(
      repo.credentials.apiKeys.insert(forged as never, {
        keyId,
        appId: TA.appId,
        environmentId: TA.envId,
        keyHash: "hash_forged",
        scopes: "[]",
        createdAt: NOW,
      }),
    ).rejects.toThrow(/forged scope is rejected/);

    expect(await rawApiKeyScope(keyId)).toBeNull();
  });
});

describe("BUG 3 — a forged scope cannot be branded by lifting the marker off a real scope", () => {
  it("a minted scope exposes NO liftable own-symbol marker", () => {
    // The prior fix branded scopes with a non-enumerable own-property keyed by a
    // module-private Symbol. Non-enumerable hides it from spreads/for..in, but
    // Object.getOwnPropertySymbols() returns it regardless — so any caller could
    // lift it. Membership now lives in a module-private WeakSet, so a minted
    // scope carries no own-symbol an attacker could read off and replant.
    const realScope = appScope(TA.appId);
    expect(Object.getOwnPropertySymbols(realScope)).toHaveLength(0);
  });

  it("scopedTable.insert with a symbol-lift forged App scope throws and persists no row", async () => {
    const flagId = "flag_lift_app";
    const realScope = appScope(TA.appId); // attacker's OWN legitimate scope

    // The exact exploit: lift any own-symbol off a legitimate scope and brand a
    // forged plain object targeting the VICTIM tenant. Post-fix there is no
    // liftable marker symbol, so this copies whatever own-symbols exist (none) —
    // and even a forged object that copied every own key + symbol is rejected,
    // because WeakSet membership is by object identity, not shape.
    const forged: Record<PropertyKey, unknown> = { appId: TB.appId };
    for (const sym of Object.getOwnPropertySymbols(realScope)) {
      forged[sym] = (realScope as Record<PropertyKey, unknown>)[sym];
    }
    for (const key of Object.getOwnPropertyNames(realScope)) {
      if (!(key in forged)) forged[key] = (realScope as Record<PropertyKey, unknown>)[key];
    }
    // appId must still target the victim even after copying real keys.
    forged.appId = TB.appId;

    await expect(
      repo.flags.flags.insert(forged as unknown as TenantScope, {
        id: flagId,
        appId: TA.appId,
        key: `${TB.flagKey}-lift`,
        name: "lift-forged",
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).rejects.toThrow(/forged scope is rejected/);

    // Raw read: nothing landed under the victim tenant B (or anywhere).
    expect(await rawFlagAppId(flagId)).toBeNull();
  });

  it("scopedTable.insert with a symbol-lift forged Env scope throws and persists no api_key", async () => {
    const keyId = "key_lift_env";
    const realScope = envScope(TA.appId, TA.envId);

    const forged: Record<PropertyKey, unknown> = { appId: TB.appId, environmentId: TB.envId };
    for (const sym of Object.getOwnPropertySymbols(realScope)) {
      forged[sym] = (realScope as Record<PropertyKey, unknown>)[sym];
    }
    for (const key of Object.getOwnPropertyNames(realScope)) {
      if (!(key in forged)) forged[key] = (realScope as Record<PropertyKey, unknown>)[key];
    }
    forged.appId = TB.appId;
    forged.environmentId = TB.envId;

    await expect(
      repo.credentials.apiKeys.insert(forged as unknown as TenantScope as never, {
        keyId,
        appId: TA.appId,
        environmentId: TA.envId,
        keyHash: "hash_lift",
        scopes: "[]",
        createdAt: NOW,
      }),
    ).rejects.toThrow(/forged scope is rejected/);

    expect(await rawApiKeyScope(keyId)).toBeNull();
  });
});

describe("BUG 1 — a minted scope is immutable; it cannot be rebound to another tenant", () => {
  it("appScope is frozen: reassigning appId throws and the write still lands in tenant-a", async () => {
    const s = appScope(TA.appId);
    // ESM modules are strict by default, so assigning to a frozen property throws.
    expect(() => {
      (s as { appId: string }).appId = TB.appId;
    }).toThrow();
    expect(s.appId).toBe(TA.appId);

    const flagId = "flag_frozen_app";
    await repo.flags.flags.insert(s, {
      id: flagId,
      appId: TB.appId, // input lies; the (unmutated) scope must win
      key: `${TA.flagKey}-frozen`,
      name: "frozen",
      createdAt: NOW,
      updatedAt: NOW,
    });

    expect(await rawFlagAppId(flagId)).toBe(TA.appId);
  });

  it("envScope is frozen: reassigning environmentId throws and the write keeps tenant-a's env", async () => {
    const s = envScope(TA.appId, TA.envId);
    expect(() => {
      (s as { environmentId: string }).environmentId = TB.envId;
    }).toThrow();
    expect(() => {
      (s as { appId: string }).appId = TB.appId;
    }).toThrow();
    expect(s.appId).toBe(TA.appId);
    expect(s.environmentId).toBe(TA.envId);

    const keyId = "key_frozen_env";
    await repo.credentials.apiKeys.insert(s, {
      keyId,
      appId: TB.appId,
      environmentId: TB.envId, // input lies on both axes
      keyHash: "hash_frozen",
      scopes: "[]",
      createdAt: NOW,
    });

    const persisted = await rawApiKeyScope(keyId);
    expect(persisted?.app_id).toBe(TA.appId);
    expect(persisted?.environment_id).toBe(TA.envId);
  });
});

describe("no regression — a normally minted scope writes and reads back", () => {
  it("App-scoped insert then scoped read round-trips", async () => {
    const flagId = "flag_happy_app";
    const s = appScope(TA.appId);
    const inserted = await repo.flags.flags.insert(s, {
      id: flagId,
      appId: TA.appId,
      key: `${TA.flagKey}-happy`,
      name: "happy",
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(inserted.id).toBe(flagId);
    expect(inserted.appId).toBe(TA.appId);

    expect(await rawFlagAppId(flagId)).toBe(TA.appId);
    const readBack = await repo.flags.getFlag(s, flagId);
    expect(readBack?.id).toBe(flagId);
    // cross-tenant: B cannot read A's flag
    expect(await repo.flags.getFlag(appScope(TB.appId), flagId)).toBeNull();
  });

  it("Env-scoped insert then scoped read round-trips", async () => {
    const keyId = "key_happy_env";
    const s = envScope(TA.appId, TA.envId);
    await repo.credentials.apiKeys.insert(s, {
      keyId,
      appId: TA.appId,
      environmentId: TA.envId,
      keyHash: "hash_happy",
      scopes: "[]",
      createdAt: NOW,
    });

    const persisted = await rawApiKeyScope(keyId);
    expect(persisted?.app_id).toBe(TA.appId);
    expect(persisted?.environment_id).toBe(TA.envId);

    const readBack = await repo.credentials.getApiKey(s, keyId);
    expect(readBack?.keyId).toBe(keyId);
  });
});
