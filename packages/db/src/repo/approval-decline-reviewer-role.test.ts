import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appScope, createRepository } from "../index";
import type { ApprovalDisposition } from "./approval-types";
import { createLocalD1, type LocalD1 } from "./test-d1";
import { type SeededTenants, seedTwoTenants } from "./test-seed";

/**
 * Declining and stale-materializing resolve an Approval Request and write an
 * audit row, so they need the same reviewer-role backstop the apply paths get
 * from `approvalPendingCondition`.
 *
 * This suite calls the repository seam DIRECTLY. That is the service-layer role
 * check "mutated out": under ADR-0018 the data-access seam is the security
 * boundary, so the refusal has to hold here with no help from above it.
 */

const NOW = "2026-07-03T12:00:00.000Z";

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

async function seedMembership(userId: string, role: string): Promise<void> {
  await local.d1
    .prepare("INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES (?,?,?,?)")
    .bind(seed.a.appId, userId, role, NOW)
    .run();
}

async function seedPendingRequest(): Promise<string> {
  const created = await repo.approvals.createRequest(appScope(seed.a.appId), {
    id: "apr_decline_role",
    operation: "flag_config_update",
    targetType: "flag_configuration",
    targetId: seed.a.flagId,
    targetVersion: "1",
    policyContexts: "[]",
    diff: JSON.stringify({ current: {}, proposed: {} }),
    status: "pending",
    proposedBy: "user_a_owner",
    proposedVia: "api_key",
    proposedAt: NOW,
    idempotencyKey: "idem_decline_role",
    requestHash: "sha256:a",
  });
  if (!created.ok) throw new Error("seed: Approval Request was not created");
  return created.request.id;
}

function disposition(
  requestId: string,
  reviewedBy: string,
  outcome: "declined" | "stale",
): ApprovalDisposition {
  return {
    requestId,
    reviewId: `rev_${reviewedBy}`,
    action: outcome === "declined" ? "decline" : "approve_and_apply",
    outcome,
    reviewedBy,
    reviewedVia: "api_key",
    reviewedAt: NOW,
    reason: null,
    idempotencyKey: `idem_${reviewedBy}`,
    requestHash: "sha256:a",
  };
}

/** Ground truth: a raw, scope-free read of what actually persisted. */
async function persisted(requestId: string) {
  const request = await local.d1
    .prepare("SELECT status, resolved_at FROM approval_requests WHERE id = ?")
    .bind(requestId)
    .first<{ status: string; resolved_at: string | null }>();
  const reviews = await local.d1
    .prepare("SELECT id, reviewed_by, outcome FROM approval_reviews")
    .all();
  return { request, reviews: reviews.results };
}

describe("resolving an Approval Request requires a reviewer role at the D1 seam", () => {
  it("a member cannot decline, and nothing is written", async () => {
    const requestId = await seedPendingRequest();
    await seedMembership("user_a_member", "member");

    const landed = await repo.approvals.resolveWithoutApplication(
      appScope(seed.a.appId),
      disposition(requestId, "user_a_member", "declined"),
    );

    expect(landed).toBe(false);
    expect(await persisted(requestId)).toMatchObject({
      request: { status: "pending", resolved_at: null },
      reviews: [],
    });
  });

  it("a user with no membership row at all cannot decline", async () => {
    const requestId = await seedPendingRequest();

    const landed = await repo.approvals.resolveWithoutApplication(
      appScope(seed.a.appId),
      disposition(requestId, "user_a_stranger", "declined"),
    );

    expect(landed).toBe(false);
    expect(await persisted(requestId)).toMatchObject({
      request: { status: "pending" },
      reviews: [],
    });
  });

  it("a member cannot materialize the Request as stale either", async () => {
    const requestId = await seedPendingRequest();
    await seedMembership("user_a_member", "member");

    const landed = await repo.approvals.resolveWithoutApplication(
      appScope(seed.a.appId),
      disposition(requestId, "user_a_member", "stale"),
    );

    expect(landed).toBe(false);
    expect(await persisted(requestId)).toMatchObject({ request: { status: "pending" } });
  });

  it("positive control: an admin still declines, so the refusal is the role and not an inert path", async () => {
    const requestId = await seedPendingRequest();
    await seedMembership("user_a_admin", "admin");

    const landed = await repo.approvals.resolveWithoutApplication(
      appScope(seed.a.appId),
      disposition(requestId, "user_a_admin", "declined"),
    );

    expect(landed).toBe(true);
    const state = await persisted(requestId);
    expect(state.request).toMatchObject({ status: "declined", resolved_at: NOW });
    expect(state.reviews).toMatchObject([{ reviewed_by: "user_a_admin", outcome: "declined" }]);
  });

  it("an owner in ANOTHER App cannot borrow that role to decline here", async () => {
    const requestId = await seedPendingRequest();
    await local.d1
      .prepare("INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES (?,?,?,?)")
      .bind(seed.b.appId, "user_b_owner", "owner", NOW)
      .run();

    const landed = await repo.approvals.resolveWithoutApplication(
      appScope(seed.a.appId),
      disposition(requestId, "user_b_owner", "declined"),
    );

    expect(landed).toBe(false);
    expect(await persisted(requestId)).toMatchObject({ request: { status: "pending" } });
  });
});
