import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appScope, createRepository } from "../index";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";
import { type SeededTenants, seedTwoTenants } from "./test-seed";

/**
 * SPL-326 security proof: App-force privacy cascade helpers must not wipe
 * another tenant's ledger. Single-tenant fixtures cannot distinguish a scoped
 * DELETE from an unscoped one (SPL-11 lesson).
 */

const NOW = "2026-08-05T12:00:00.000Z";

let local: LocalD1;
let repo: ReturnType<typeof createRepository>;
let seed: SeededTenants;

beforeEach(async () => {
  local = await createLocalD1();
  repo = createRepository(local.d1);
  seed = await seedTwoTenants(local.d1);

  for (const tenant of [seed.a, seed.b] as const) {
    await repo.privacy.entityDeletions.insert(appScope(tenant.appId), {
      appId: tenant.appId,
      idType: "user",
      targetingKeyHash: `hash_${tenant.appId}`,
      deleteBeforeTs: NOW,
      requestedAt: NOW,
    });
    await local.d1
      .prepare(
        `INSERT INTO privacy_requests (
           request_id, org_id, app_id, request_type, subject_type, subject_ref,
           requested_by, status, received_at, ack_due_at, response_due_at
         ) VALUES (?, ?, ?, 'delete', 'user', ?, ?, 'received', ?, ?, ?)`,
      )
      .bind(
        `prv_${tenant.appId}`,
        tenant.orgId,
        tenant.appId,
        `subject_${tenant.appId}`,
        `user_${tenant.appId}`,
        NOW,
        NOW,
        NOW,
      )
      .run();
  }
});

afterEach(async () => {
  await local.dispose();
});

async function rawEntityDeletionCount(appId: string): Promise<number> {
  const row = await local.d1
    .prepare("SELECT COUNT(*) AS n FROM entity_deletions WHERE app_id = ?")
    .bind(appId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function rawPrivacyRequestCount(orgId: string, appId: string): Promise<number> {
  const row = await local.d1
    .prepare("SELECT COUNT(*) AS n FROM privacy_requests WHERE org_id = ? AND app_id = ?")
    .bind(orgId, appId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("privacy cascade helpers tenant isolation (SPL-326)", () => {
  it("deleteEntityDeletionsForApp removes only the issuing App's tombstones", async () => {
    expect(await rawEntityDeletionCount(seed.a.appId)).toBe(1);
    expect(await rawEntityDeletionCount(seed.b.appId)).toBe(1);

    const removed = await repo.privacy.deleteEntityDeletionsForApp(appScope(seed.a.appId));
    expect(removed).toBe(1);

    expect(await rawEntityDeletionCount(seed.a.appId)).toBe(0);
    expect(await rawEntityDeletionCount(seed.b.appId)).toBe(1);
  });

  it("deleteEntityDeletionsForApp refuses a forged scope (ADR-0018 seam)", async () => {
    await expect(
      repo.privacy.deleteEntityDeletionsForApp({ appId: seed.a.appId } as never),
    ).rejects.toThrow(/not minted/);
    expect(await rawEntityDeletionCount(seed.a.appId)).toBe(1);
    expect(await rawEntityDeletionCount(seed.b.appId)).toBe(1);
  });

  it("deletePrivacyRequestsForApp is bound by org_id AND app_id", async () => {
    expect(await rawPrivacyRequestCount(seed.a.orgId, seed.a.appId)).toBe(1);
    expect(await rawPrivacyRequestCount(seed.b.orgId, seed.b.appId)).toBe(1);

    const removed = await repo.privacy.deletePrivacyRequestsForApp(seed.a.orgId, seed.a.appId);
    expect(removed).toBe(1);

    expect(await rawPrivacyRequestCount(seed.a.orgId, seed.a.appId)).toBe(0);
    expect(await rawPrivacyRequestCount(seed.b.orgId, seed.b.appId)).toBe(1);
  });

  it("deletePrivacyRequestsForApp with the wrong orgId cannot wipe another tenant", async () => {
    // Crossed predicates: A's org with B's app (and vice versa) must match zero
    // rows. Dropping either side of the AND would let this wipe B.
    expect(await repo.privacy.deletePrivacyRequestsForApp(seed.a.orgId, seed.b.appId)).toBe(0);
    expect(await repo.privacy.deletePrivacyRequestsForApp(seed.b.orgId, seed.a.appId)).toBe(0);
    expect(await rawPrivacyRequestCount(seed.a.orgId, seed.a.appId)).toBe(1);
    expect(await rawPrivacyRequestCount(seed.b.orgId, seed.b.appId)).toBe(1);
  });

  it("deletePrivacyRequestsForApp refuses blank tenant ids", async () => {
    await expect(repo.privacy.deletePrivacyRequestsForApp("", seed.a.appId)).rejects.toThrow(
      /required/,
    );
    await expect(repo.privacy.deletePrivacyRequestsForApp(seed.a.orgId, "")).rejects.toThrow(
      /required/,
    );
  });
});
