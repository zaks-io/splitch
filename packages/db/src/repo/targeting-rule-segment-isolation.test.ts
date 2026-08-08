import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApprovalCommit,
  appScope,
  createRepository,
  envScope,
  type TenantScope,
} from "../index";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";

/**
 * Tenant-boundary proofs for the Segment-reference readers and the Segment
 * approval write. All three drop to raw `db` rather than a scoped table, so the
 * `app_id` predicate and the minted-scope assertion are hand-written there and
 * nothing else re-applies them (ADR-0018: this seam IS the boundary).
 *
 * DISTINCT ids and keys per tenant throughout: identical seeds let a UNIQUE index
 * make a leak look blocked when it was only a collision.
 */

const NOW = "2026-08-07T00:00:00.000Z";

const TA = {
  orgId: "org_seg_iso_a",
  appId: "app_seg_iso_a",
  envId: "env_seg_iso_a",
  flagId: "flag_seg_iso_a",
  segmentId: "segment_seg_iso_a",
  ruleId: "rule_seg_iso_a",
};
const TB = {
  orgId: "org_seg_iso_b",
  appId: "app_seg_iso_b",
  envId: "env_seg_iso_b",
  flagId: "flag_seg_iso_b",
  segmentId: "segment_seg_iso_b",
  ruleId: "rule_seg_iso_b",
};

let local: LocalD1;
let repo: ReturnType<typeof createRepository>;

async function seedTenant(t: typeof TA): Promise<void> {
  await local.d1
    .prepare(
      "INSERT INTO organizations (id, name, slug, plan, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    )
    .bind(t.orgId, t.orgId, t.orgId, "free", NOW, NOW)
    .run();
  await local.d1
    .prepare(
      "INSERT INTO apps (id, organization_id, name, key, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    )
    .bind(t.appId, t.orgId, t.appId, t.appId, NOW, NOW)
    .run();
  await repo.identity.environments.insert(appScope(t.appId), {
    id: t.envId,
    appId: t.appId,
    key: `key-${t.envId}`,
    name: "Production",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repo.flags.flags.insert(appScope(t.appId), {
    id: t.flagId,
    appId: t.appId,
    key: `key-${t.flagId}`,
    name: t.flagId,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repo.flags.segments.insert(appScope(t.appId), {
    id: t.segmentId,
    appId: t.appId,
    name: t.segmentId,
    conditions: JSON.stringify([{ attribute: "plan", operator: "eq", value: "paid" }]),
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repo.flags.targetingRules.insert(envScope(t.appId, t.envId), {
    id: t.ruleId,
    appId: t.appId,
    environmentId: t.envId,
    flagId: t.flagId,
    priority: 0,
    conditions: "[]",
    segmentId: t.segmentId,
    variantId: null,
    percentageRollout: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

beforeAll(async () => {
  local = await createLocalD1();
  repo = createRepository(local.d1);
  await seedTenant(TA);
  await seedTenant(TB);
});

afterAll(async () => {
  await local.dispose();
});

describe("Segment-reference readers are App-scoped", () => {
  it("listTargetingRuleEnvironmentReferences returns only the caller's App", async () => {
    const references = await repo.flags.listTargetingRuleEnvironmentReferences(appScope(TA.appId));

    expect(references).toEqual([{ segmentId: TA.segmentId, environmentId: TA.envId }]);
    expect(await repo.flags.listTargetingRuleEnvironmentReferences(appScope(TB.appId))).toEqual([
      { segmentId: TB.segmentId, environmentId: TB.envId },
    ]);
  });

  it("listTargetingRulesBySegment refuses another App's Segment id", async () => {
    // The `segments.id` PRIMARY KEY is global, so tenant B can name tenant A's
    // Segment id and the query would answer with A's rows if the App predicate
    // were dropped.
    expect(await repo.flags.listTargetingRulesBySegment(appScope(TB.appId), TA.segmentId)).toEqual(
      [],
    );
    expect(
      (await repo.flags.listTargetingRulesBySegment(appScope(TA.appId), TA.segmentId)).map(
        (rule) => rule.id,
      ),
    ).toEqual([TA.ruleId]);
  });

  it("rejects a forged scope instead of binding the appId it carries", async () => {
    const forged = { appId: TA.appId } as unknown as TenantScope;

    // The two readers are not `async`, so the guard rejects the call before a
    // promise exists at all.
    expect(() => repo.flags.listTargetingRulesBySegment(forged, TA.segmentId)).toThrow(
      /forged scope is rejected/,
    );
    expect(() => repo.flags.listTargetingRuleEnvironmentReferences(forged)).toThrow(
      /forged scope is rejected/,
    );
    await expect(
      repo.flags.updateSegment(forged, TA.segmentId, { name: "forged" }, forgedApprovalCommit()),
    ).rejects.toThrow(/forged scope is rejected/);

    const untouched = await repo.flags.getSegment(appScope(TA.appId), TA.segmentId);
    expect(untouched?.name).toBe(TA.segmentId);
  });
});

function forgedApprovalCommit(): ApprovalCommit {
  return {
    requestId: "approval_forged",
    reviewId: "review_forged",
    action: "approve_and_apply",
    reviewedBy: "user_forged",
    reviewedVia: "api",
    reviewedAt: NOW,
    reason: null,
    idempotencyKey: "idem_forged",
    requestHash: "hash_forged",
    resultingTargetVersion: "1",
    resultingResourceType: "segment",
    resultingResourceId: TA.segmentId,
    policyContexts: [],
  };
}

describe("the Segment approval write is App-scoped", () => {
  it("refuses another App's Segment id under a pending Approval Request", async () => {
    const commit = crossTenantCommit();
    await seedPendingCrossTenantRequest(commit);

    const result = await repo.flags.updateSegment(
      appScope(TA.appId),
      TB.segmentId,
      {
        name: "PWNED",
        conditions: JSON.stringify([{ attribute: "plan", operator: "eq", value: "free" }]),
      },
      commit,
    );

    // Not the guard: the re-read after the UPDATE is App-scoped, so this is null
    // either way. The App B row below is the assertion that goes red.
    expect(result).toBeNull();
    // `approvalPendingCondition` is an EXISTS over `approval_requests` that is
    // uncorrelated to the row being updated: it proves the Approval Request
    // belongs to the scope, never that the Segment does. The `app_id` predicate
    // on the UPDATE itself is the only thing bounding the target row.
    expect(await repo.flags.getSegment(appScope(TB.appId), TB.segmentId)).toMatchObject({
      name: TB.segmentId,
      conditions: JSON.stringify([{ attribute: "plan", operator: "eq", value: "paid" }]),
    });
  });
});

/**
 * A pending `segments_update` Approval Request in App A naming App B's Segment,
 * reviewed by a principal who holds owner in both Apps. Every predicate the
 * approval branch checks besides the target row's `app_id` passes.
 */
async function seedPendingCrossTenantRequest(commit: ApprovalCommit): Promise<void> {
  for (const appId of [TA.appId, TB.appId]) {
    await local.d1
      .prepare("INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES (?,?,?,?)")
      .bind(appId, commit.reviewedBy, "owner", NOW)
      .run();
  }
  await local.d1
    .prepare(
      `INSERT INTO approval_requests (id, app_id, operation, target_type, target_id, target_version,
        policy_contexts, diff, status, proposed_by, proposed_via, proposed_at, idempotency_key, request_hash)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      commit.requestId,
      TA.appId,
      "segments_update",
      "segment",
      TB.segmentId,
      "1",
      "[]",
      "{}",
      "pending",
      commit.reviewedBy,
      "api",
      NOW,
      commit.idempotencyKey,
      commit.requestHash,
    )
    .run();
}

function crossTenantCommit(): ApprovalCommit {
  return {
    ...forgedApprovalCommit(),
    requestId: "approval_cross_tenant",
    reviewId: "review_cross_tenant",
    reviewedBy: "user_cross_tenant",
    idempotencyKey: "idem_cross_tenant",
    requestHash: "hash_cross_tenant",
    resultingResourceId: TB.segmentId,
  };
}
