import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appScope, createRepository, envScope } from "../index";
import type { ApprovalCommit } from "./approval-types";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";
import { type SeededTenants, seedTwoTenants } from "./test-seed";

/**
 * `targeting_rules.variant_id` has no SQLite FK. A preflight list plus an
 * unconditional DELETE (or INSERT) is a check-then-act race: the opposite
 * writer can commit in the window and leave a dangling reference.
 *
 * The interleaving here is DETERMINISTIC. The D1 binding is wrapped so the
 * competing write lands immediately before the first `batch` — after the
 * repository has read the current rows and before any of its statements
 * commit. A test that cannot place the write in that window proves nothing.
 */

const NOW = "2026-08-27T20:00:00.000Z";
const TREATMENT_ID = "var_a_treatment";
const RULE_ID = "rule_a_treatment";
const REVIEWER = "user_race_owner";

let local: LocalD1;
let seed: SeededTenants;

beforeEach(async () => {
  local = await createLocalD1();
  seed = await seedTwoTenants(local.d1);
  await createRepository(local.d1).flags.addVariant(appScope(seed.a.appId), seed.a.flagId, {
    id: TREATMENT_ID,
    name: "treatment",
    value: '"treatment"',
    createdAt: NOW,
  });
});

afterEach(async () => {
  await local.dispose();
});

function d1WithWriteBeforeFirstBatch(d1: D1Database, competing: () => Promise<unknown>) {
  let fired = false;
  return new Proxy(d1, {
    get(target, property, receiver) {
      if (property !== "batch") return Reflect.get(target, property, receiver);
      return async (statements: unknown[]) => {
        if (!fired) {
          fired = true;
          await competing();
        }
        return (target as D1Database).batch(statements as never);
      };
    },
  }) as D1Database;
}

async function insertTreatmentRule(): Promise<void> {
  await local.d1
    .prepare(
      `INSERT INTO targeting_rules (
         id, app_id, environment_id, flag_id, priority, conditions, variant_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 0, '[]', ?, ?, ?)`,
    )
    .bind(RULE_ID, seed.a.appId, seed.a.environmentId, seed.a.flagId, TREATMENT_ID, NOW, NOW)
    .run();
}

async function seedFlagConfig(): Promise<void> {
  await createRepository(local.d1).flags.flagConfigs.insert(
    envScope(seed.a.appId, seed.a.environmentId),
    {
      id: "cfg_a",
      appId: seed.a.appId,
      environmentId: seed.a.environmentId,
      flagId: seed.a.flagId,
      enabled: false,
      availableVariantNames: "[]",
      createdAt: NOW,
      updatedAt: NOW,
    },
  );
}

async function seedReviewerAndRequest(): Promise<string> {
  await local.d1
    .prepare("INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES (?,?,?,?)")
    .bind(seed.a.appId, REVIEWER, "owner", NOW)
    .run();
  const created = await createRepository(local.d1).approvals.createRequest(appScope(seed.a.appId), {
    id: "apr_race",
    operation: "flag_variants_delete",
    targetType: "flag_variant",
    targetId: TREATMENT_ID,
    targetVersion: "1",
    policyContexts: "[]",
    diff: JSON.stringify({ current: {}, proposed: {} }),
    status: "pending",
    proposedBy: "user_race_proposer",
    proposedVia: "api_key",
    proposedAt: NOW,
    idempotencyKey: "idem_race",
    requestHash: "sha256:race",
  });
  if (!created.ok) throw new Error("seed: Approval Request was not created");
  return created.request.id;
}

function commitFor(requestId: string): ApprovalCommit {
  return {
    requestId,
    reviewId: "rev_race_01",
    action: "approve_and_apply",
    reviewedBy: REVIEWER,
    reviewedVia: "api_key",
    reviewedAt: NOW,
    reason: null,
    idempotencyKey: "idem_race_review",
    requestHash: "sha256:race",
    resultingTargetVersion: "2",
    resultingResourceType: "flag_variant",
    resultingResourceId: TREATMENT_ID,
    policyContexts: [],
  };
}

async function danglingVariantIds(): Promise<string[]> {
  const rows = await local.d1
    .prepare(
      `SELECT targeting_rules.variant_id AS variantId
       FROM targeting_rules
       WHERE targeting_rules.app_id = ?
         AND targeting_rules.variant_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM variants WHERE variants.id = targeting_rules.variant_id)`,
    )
    .bind(seed.a.appId)
    .all<{ variantId: string }>();
  return (rows.results ?? []).map((row) => row.variantId);
}

async function treatmentExists(): Promise<boolean> {
  const row = await local.d1
    .prepare("SELECT id FROM variants WHERE id = ?")
    .bind(TREATMENT_ID)
    .first<{ id: string }>();
  return row !== null;
}

describe("Variant delete refuses a Targeting Rule that lands in the write window", () => {
  it("direct delete: a concurrent rule insert cannot leave a dangler", async () => {
    const racy = createRepository(d1WithWriteBeforeFirstBatch(local.d1, insertTreatmentRule));

    const removed = await racy.flags.removeVariant(
      appScope(seed.a.appId),
      seed.a.flagId,
      "treatment",
    );

    expect(removed).toEqual({
      ok: false,
      reason: "TARGETING_RULE_REFS",
      variantName: "treatment",
      targetingRules: [{ id: RULE_ID, environmentId: seed.a.environmentId }],
    });
    expect(await treatmentExists()).toBe(true);
    expect(await danglingVariantIds()).toEqual([]);
  });

  it("approved delete: a concurrent rule insert cannot leave a dangler", async () => {
    const requestId = await seedReviewerAndRequest();
    const racy = createRepository(d1WithWriteBeforeFirstBatch(local.d1, insertTreatmentRule));

    const removed = await racy.flags.removeVariant(
      appScope(seed.a.appId),
      seed.a.flagId,
      "treatment",
      { approval: commitFor(requestId) },
    );

    expect(removed).toEqual({
      ok: false,
      reason: "TARGETING_RULE_REFS",
      variantName: "treatment",
      targetingRules: [{ id: RULE_ID, environmentId: seed.a.environmentId }],
    });
    expect(await treatmentExists()).toBe(true);
    expect(await danglingVariantIds()).toEqual([]);
    const request = await local.d1
      .prepare("SELECT status FROM approval_requests WHERE id = ?")
      .bind(requestId)
      .first<{ status: string }>();
    expect(request?.status).toBe("pending");
    const reviews = await local.d1.prepare("SELECT id FROM approval_reviews").all();
    expect(reviews.results.length).toBe(0);
  });

  it("positive control: the same delete applies when nothing races it", async () => {
    const removed = await createRepository(local.d1).flags.removeVariant(
      appScope(seed.a.appId),
      seed.a.flagId,
      "treatment",
    );

    expect(removed).toEqual({ ok: true });
    expect(await treatmentExists()).toBe(false);
    expect(await danglingVariantIds()).toEqual([]);
  });
});

describe("Targeting Rule replace refuses a Variant that vanished in the write window", () => {
  it("does not insert a rule after the referenced Variant is deleted", async () => {
    await seedFlagConfig();
    await insertTreatmentRule();
    const racy = createRepository(
      d1WithWriteBeforeFirstBatch(local.d1, () =>
        local.d1.prepare("DELETE FROM variants WHERE id = ?").bind(TREATMENT_ID).run(),
      ),
    );

    const replaced = await racy.flags.replaceTargetingRules(
      envScope(seed.a.appId, seed.a.environmentId),
      seed.a.flagId,
      [
        {
          id: "rule_a_replacement",
          priority: 0,
          conditions: "[]",
          segmentId: null,
          variantId: TREATMENT_ID,
          percentageRollout: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      { updatedAt: NOW },
    );

    expect(replaced).toEqual({
      ok: false,
      reason: "missing_variant",
      missingVariantIds: [TREATMENT_ID],
    });
    expect(await treatmentExists()).toBe(false);
    const leftover = await local.d1
      .prepare("SELECT id FROM targeting_rules WHERE app_id = ? AND flag_id = ?")
      .bind(seed.a.appId, seed.a.flagId)
      .all<{ id: string }>();
    expect((leftover.results ?? []).map((row) => row.id)).toEqual([RULE_ID]);
    expect(await danglingVariantIds()).toEqual([]);
  });
});
