import { appScope, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, ids, setProdPolicy, token } from "../src/config-store-harness-core";
import {
  allowPolicy,
  clearFrozenRun,
  confirmPolicy,
  countApprovalReviews,
  deleteVariantRequest,
  NOW_APPROVAL,
  readRequest,
  reviewRequest,
} from "./approval-harness";
import { makePoolHarness } from "./config-store-pool-harness";

/**
 * SPL-207: deleting a Variant must refuse while any Targeting Rule names it in
 * `variant_id`. The available-set check and `servesVariant` do not answer that.
 */

let h: Harness;

beforeEach(async () => {
  h = await makePoolHarness();
  await clearFrozenRun(h);
  for (const envId of [ids.environmentId, ids.devEnvironmentId]) {
    await h.repo.flags.updateFlagConfig(envScope(ids.appId, envId), ids.flagId, {
      availableVariantNames: JSON.stringify([]),
      enabled: true,
      updatedAt: "2026-07-02T09:00:00.000Z",
    });
  }
});

afterEach(async () => {
  await h.dispose();
});

interface DeleteError {
  status: number;
  code?: string;
  approvalRequestId?: string;
  details: {
    resourceType?: string;
    resourceId?: string;
    childType?: string;
    childCount?: number;
    attemptedOp?: string;
    targetingRuleIds?: string[];
    targetingRules?: Array<{ id: string; environmentId: string }>;
  };
}

function treatment() {
  return h.repo.flags.getVariantById(appScope(ids.appId), ids.treatmentVariantId);
}

async function danglingVariantIds(): Promise<string[]> {
  const rows = await h.d1
    .prepare(
      `SELECT targeting_rules.variant_id AS variantId
       FROM targeting_rules
       WHERE targeting_rules.app_id = ?
         AND targeting_rules.variant_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM variants WHERE variants.id = targeting_rules.variant_id)`,
    )
    .bind(ids.appId)
    .all<{ variantId: string }>();
  return (rows.results ?? []).map((row) => row.variantId);
}

async function deleteFixtureTargetingRules(): Promise<void> {
  await h.d1
    .prepare("DELETE FROM targeting_rules WHERE app_id = ? AND flag_id = ?")
    .bind(ids.appId, ids.flagId)
    .run();
}

async function insertProdTreatmentRule(ruleId = "rule_prod_treatment"): Promise<string> {
  await h.repo.flags.targetingRules.insert(envScope(ids.appId, ids.environmentId), {
    id: ruleId,
    appId: ids.appId,
    environmentId: ids.environmentId,
    flagId: ids.flagId,
    priority: 0,
    conditions: JSON.stringify([{ attribute: "plan", operator: "eq", value: "pro" }]),
    variantId: ids.treatmentVariantId,
    createdAt: NOW_APPROVAL,
    updatedAt: NOW_APPROVAL,
  });
  return ruleId;
}

async function deleteTreatment(key: string): Promise<DeleteError> {
  const jwt = await token(h.signer);
  const response = await h.app.request(
    `/apps/${ids.appId}/flags/${ids.flagId}/variants/treatment`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${jwt}`, "idempotency-key": key },
    },
  );
  const parsed = (await response.json()) as {
    code?: string;
    details?: DeleteError["details"] & { approvalRequestId?: string };
  };
  return {
    status: response.status,
    code: parsed.code,
    approvalRequestId: parsed.details?.approvalRequestId,
    details: parsed.details ?? {},
  };
}

describe("Variant delete refuses Targeting Rule references (allow)", () => {
  it("refuses an ungated delete and names the referencing rules", async () => {
    await setProdPolicy(h, allowPolicy);

    const removed = await deleteTreatment("tr_allow");

    expect(removed.status).toBe(409);
    expect(removed).toMatchObject({
      code: "RESOURCE_NOT_EMPTY",
      details: {
        resourceType: "variant",
        resourceId: "treatment",
        childType: "flag-targeting-rules",
        childCount: 1,
        attemptedOp: "DELETE_VARIANT",
        targetingRuleIds: [ids.devTargetingRuleId],
        targetingRules: [{ id: ids.devTargetingRuleId, environmentId: ids.devEnvironmentId }],
      },
    });
    expect(await treatment()).not.toBeNull();
    expect(await danglingVariantIds()).toEqual([]);
  });
});

describe("Variant delete refuses Targeting Rule references (confirm proposal)", () => {
  it("refuses the proposal instead of minting an Approval Request", async () => {
    await setProdPolicy(h, confirmPolicy);
    const before = await h.repo.approvals.countRequests(appScope(ids.appId), {});

    const removed = await deleteTreatment("tr_propose");

    expect(removed.status).toBe(409);
    expect(removed.code).toBe("RESOURCE_NOT_EMPTY");
    expect(removed.details.targetingRuleIds).toEqual([ids.devTargetingRuleId]);
    expect(removed.approvalRequestId).toBeUndefined();
    expect(await h.repo.approvals.countRequests(appScope(ids.appId), {})).toBe(before);
    expect(await treatment()).not.toBeNull();
  });
});

describe("Variant delete applies when no Targeting Rule references the Variant", () => {
  it("removes the Variant only when the confirm delete is approved", async () => {
    await deleteFixtureTargetingRules();
    await setProdPolicy(h, confirmPolicy);

    const removed = await deleteVariantRequest(h, "treatment", "tr_apply");
    expect(removed.status).toBe(409);
    expect(removed.code).toBe("APPROVAL_REVIEW_REQUIRED");

    const applied = await reviewRequest(h, removed.approvalRequestId as string, "tr_apply_r");
    expect(applied.status).toBe(200);
    expect(await treatment()).toBeNull();
    expect(await countApprovalReviews(h)).toBe(1);
    expect(await danglingVariantIds()).toEqual([]);
  });
});

describe("Variant delete re-checks Targeting Rules when an approved Request applies", () => {
  it("refuses the apply if a rule appeared after the proposal", async () => {
    await deleteFixtureTargetingRules();
    await setProdPolicy(h, confirmPolicy);

    const proposed = await deleteVariantRequest(h, "treatment", "tr_race");
    expect(proposed.status).toBe(409);
    expect(proposed.code).toBe("APPROVAL_REVIEW_REQUIRED");

    const ruleId = await insertProdTreatmentRule();
    const applied = await reviewRequest(h, proposed.approvalRequestId as string, "tr_race_r");
    const body = (await applied.json()) as {
      code: string;
      details: { targetingRuleIds?: string[]; targetingRules?: unknown };
    };

    expect(applied.status).toBe(409);
    expect(body).toMatchObject({
      code: "RESOURCE_NOT_EMPTY",
      details: {
        targetingRuleIds: [ruleId],
        targetingRules: [{ id: ruleId, environmentId: ids.environmentId }],
      },
    });
    expect(await treatment()).not.toBeNull();
    expect(await danglingVariantIds()).toEqual([]);

    const stored = await readRequest(h, proposed.approvalRequestId as string);
    expect(stored.body.status).toBe("stale");
  });
});
