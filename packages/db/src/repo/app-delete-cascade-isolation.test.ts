import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appScope, createRepository, envScope } from "../index";
import { createLocalD1, type LocalD1 } from "./test-d1";
import { type SeededTenants, seedTwoTenants } from "./test-seed";

/**
 * SPL-298 security proof: raw-SQL App cascade must not delete another tenant's
 * rows. Single-tenant fixtures cannot distinguish `WHERE app_id = ?` from
 * `WHERE app_id = ? OR 1=1`. Uses the shared `seedTwoTenants` helper only.
 */

const NOW = "2026-08-04T12:00:00.000Z";
const USER_A = "user_cascade_iso_a";
const USER_B = "user_cascade_iso_b";

let local: LocalD1;
let repo: ReturnType<typeof createRepository>;
let seed: SeededTenants;

beforeEach(async () => {
  local = await createLocalD1();
  repo = createRepository(local.d1);
  seed = await seedTwoTenants(local.d1);

  for (const [tenant, userId] of [
    [seed.a, USER_A],
    [seed.b, USER_B],
  ] as const) {
    await local.d1
      .prepare("INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES (?,?,?,?)")
      .bind(tenant.appId, userId, "owner", NOW)
      .run();

    await local.d1
      .prepare(
        `INSERT INTO client_keys (key_id, app_id, environment_id, key_material, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        `ck_${tenant.appId}`,
        tenant.appId,
        tenant.environmentId,
        `material_${tenant.appId}`,
        NOW,
        NOW,
      )
      .run();

    await local.d1
      .prepare(`UPDATE api_keys SET revoked_at = ? WHERE key_id = ?`)
      .bind(NOW, tenant.apiKeyId)
      .run();

    const created = await repo.approvals.createRequest(appScope(tenant.appId), {
      id: `apr_${tenant.appId}`,
      operation: "update_flag_config",
      targetType: "flag_config",
      targetId: `cfg_${tenant.appId}`,
      targetVersion: "1",
      policyContexts: "[]",
      diff: "{}",
      status: "pending",
      proposedBy: userId,
      proposedVia: "id_jag",
      proposedAt: NOW,
      resolvedAt: null,
      resultingTargetVersion: null,
      resultingResourceType: null,
      resultingResourceId: null,
      idempotencyKey: `idem_${tenant.appId}`,
      requestHash: `hash_${tenant.appId}`,
    });
    expect(created.ok).toBe(true);
  }
});

afterEach(async () => {
  await local.dispose();
});

/** Clear non-cascaded children so deleteAppCascade can succeed (emptiness guard passed). */
async function clearNonCascadedChildren(appId: string): Promise<void> {
  await local.d1.prepare(`DELETE FROM runs WHERE app_id = ?`).bind(appId).run();
  await local.d1.prepare(`DELETE FROM experiments WHERE app_id = ?`).bind(appId).run();
  await local.d1
    .prepare(`DELETE FROM variants WHERE flag_id IN (SELECT id FROM flags WHERE app_id = ?)`)
    .bind(appId)
    .run();
  await local.d1.prepare(`DELETE FROM flags WHERE app_id = ?`).bind(appId).run();
}

describe("deleteAppCascade tenant isolation (SPL-298)", () => {
  it("deleting App A leaves App B memberships, credentials, approvals, and App intact", async () => {
    await clearNonCascadedChildren(seed.a.appId);

    await repo.identity.deleteAppCascade(appScope(seed.a.appId));

    expect(await repo.identity.getApp(seed.a.appId)).toBeNull();
    expect(await repo.identity.getAppMembership(appScope(seed.a.appId), USER_A)).toBeNull();

    // Tenant B must survive every cascade DELETE. An `OR 1=1` mutation on
    // memberships or revoked credentials would wipe these rows silently.
    expect(await repo.identity.getApp(seed.b.appId)).toMatchObject({ id: seed.b.appId });
    expect(await repo.identity.getAppMembership(appScope(seed.b.appId), USER_B)).toMatchObject({
      role: "owner",
    });
    expect(await repo.identity.listEnvironments(appScope(seed.b.appId))).toHaveLength(1);

    const bEnv = envScope(seed.b.appId, seed.b.environmentId);
    const bClientKeys = await repo.credentials.listClientKeys(bEnv);
    expect(bClientKeys).toHaveLength(1);
    expect(bClientKeys[0]).toMatchObject({
      keyId: `ck_${seed.b.appId}`,
      revokedAt: NOW,
    });
    const bApiKeys = await repo.credentials.listApiKeys(bEnv);
    expect(bApiKeys).toHaveLength(1);
    expect(bApiKeys[0]).toMatchObject({
      keyId: seed.b.apiKeyId,
      revokedAt: NOW,
    });

    expect(await repo.approvals.countRequests(appScope(seed.b.appId), {})).toBe(1);
    expect(
      await local.d1
        .prepare("SELECT COUNT(*) AS n FROM approval_requests WHERE app_id = ?")
        .bind(seed.b.appId)
        .first<{ n: number }>(),
    ).toMatchObject({ n: 1 });
    expect(
      await local.d1
        .prepare("SELECT COUNT(*) AS n FROM app_memberships WHERE app_id = ?")
        .bind(seed.b.appId)
        .first<{ n: number }>(),
    ).toMatchObject({ n: 1 });
    expect(
      await local.d1
        .prepare("SELECT COUNT(*) AS n FROM client_keys WHERE app_id = ?")
        .bind(seed.b.appId)
        .first<{ n: number }>(),
    ).toMatchObject({ n: 1 });
    expect(
      await local.d1
        .prepare("SELECT COUNT(*) AS n FROM api_keys WHERE app_id = ?")
        .bind(seed.b.appId)
        .first<{ n: number }>(),
    ).toMatchObject({ n: 1 });
  });

  it("rejects a forged TenantScope that was never minted", async () => {
    await expect(repo.identity.deleteAppCascade({ appId: seed.b.appId } as never)).rejects.toThrow(
      /minted|scope/i,
    );
  });
});
