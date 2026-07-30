import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appScope, createRepository } from "../index";
import type { ApprovalDisposition } from "./approval-types";
import { createLocalD1, type LocalD1 } from "./test-d1";
import { type SeededTenants, seedTwoTenants } from "./test-seed";

/**
 * `resolveWithoutApplication` takes both a minted scope and a disposition that
 * carries its own `appId`. If the SQL keys off the disposition, the scope is
 * decoration: App A's authorized call could decline App B's Approval Request.
 * The seeds are DISTINCT per tenant so a breach shows up as a foreign row, never
 * as a coincidentally-equal fixture.
 */

const NOW = "2026-07-02T10:00:00.000Z";

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

async function seedPendingRequestForB(): Promise<string> {
  const created = await repo.approvals.createRequest(appScope(seed.b.appId), {
    id: "apr_b_victim",
    operation: "flag_config_update",
    targetType: "flag_configuration",
    targetId: seed.b.flagId,
    targetVersion: "1",
    policyContexts: "[]",
    diff: JSON.stringify({ current: {}, proposed: {} }),
    status: "pending",
    proposedBy: "user_b_owner",
    proposedVia: "api_key",
    proposedAt: NOW,
    idempotencyKey: "idem_b_victim",
    requestHash: "sha256:b",
  });
  if (!created.ok) throw new Error("seed: App B Approval Request was not created");
  return created.request.id;
}

function attackerDisposition(requestId: string): ApprovalDisposition {
  return {
    requestId,
    // FORGED: the attacker names App B while holding only App A's scope.
    appId: seed.b.appId,
    reviewId: "rev_a_attack",
    action: "decline",
    outcome: "declined",
    reviewedBy: "user_a_owner",
    reviewedVia: "api_key",
    reviewedAt: NOW,
    reason: "attack",
    idempotencyKey: "idem_a_attack",
    requestHash: "sha256:b",
  };
}

describe("a disposition cannot resolve an Approval Request outside the minted scope", () => {
  it("App A declining App B's request writes nothing and reports failure", async () => {
    const requestId = await seedPendingRequestForB();

    const resolved = await repo.approvals.resolveWithoutApplication(
      appScope(seed.a.appId),
      attackerDisposition(requestId),
    );

    expect(resolved).toBe(false);
    // Ground truth: a raw, scope-free read of what actually persisted.
    const row = await local.d1
      .prepare("SELECT app_id, status, resolved_at FROM approval_requests WHERE id = ?")
      .bind(requestId)
      .first<{ app_id: string; status: string; resolved_at: string | null }>();
    expect(row).toMatchObject({ app_id: seed.b.appId, status: "pending", resolved_at: null });
    const reviews = await local.d1.prepare("SELECT id FROM approval_reviews").all();
    expect(reviews.results.length).toBe(0);
  });

  it("the owning scope still resolves its own request", async () => {
    const requestId = await seedPendingRequestForB();

    const resolved = await repo.approvals.resolveWithoutApplication(
      appScope(seed.b.appId),
      attackerDisposition(requestId),
    );

    expect(resolved).toBe(true);
    const row = await local.d1
      .prepare("SELECT app_id, status FROM approval_requests WHERE id = ?")
      .bind(requestId)
      .first<{ app_id: string; status: string }>();
    expect(row).toMatchObject({ app_id: seed.b.appId, status: "declined" });
  });
});
