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
