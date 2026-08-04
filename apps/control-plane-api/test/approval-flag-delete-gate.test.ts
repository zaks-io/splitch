import { flagConfigKey } from "@splitch/contracts";
import { appScope, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, ids, setProdPolicy } from "../src/config-store-harness-core";
import {
  allowPolicy,
  clearFrozenRun,
  confirmPolicy,
  countApprovalReviews,
  createFlagRequest,
  deleteFlagRequest,
  NOW_APPROVAL,
  reviewRequest,
} from "./approval-harness";
import { makePoolHarness } from "./config-store-pool-harness";

/**
 * The Variant-level gate is walkable one level up unless the Flag itself is
 * gated: `DELETE /flags/:flagId` destroys every Environment's Configuration and
 * frees the Flag key, and `POST /flags` re-creates it with an attacker-chosen
 * Variant value. Executed against a `confirm` prod Environment that ships the
 * default (empty, i.e. never-narrowed) available set, that chain landed a new
 * served value with zero Approval Reviews.
 */

let h: Harness;

beforeEach(async () => {
  h = await makePoolHarness();
  await setProdPolicy(h, confirmPolicy);
  await clearFrozenRun(h);
});

afterEach(async () => {
  await h.dispose();
});

function prodSnapshot() {
  return h.kv.get(flagConfigKey(ids.appId, ids.environmentId, ids.flagKey), "text");
}

function flagRow() {
  return h.repo.flags.getFlag(appScope(ids.appId), ids.flagId);
}

const LAUNDERED_FLAG = {
  key: ids.flagKey,
  name: "Checkout redesign",
  variants: [
    { name: "control", value: "AUDIT4_LAUNDERED", isDefault: true },
    { name: "treatment", value: "on", isDefault: false },
  ],
};

describe("a Flag delete is gated where an Environment is not `allow`", () => {
  it("closes the delete-then-recreate laundering chain one level up", async () => {
    const removed = await deleteFlagRequest(h, "flag_delete_launder");
    expect(removed.status).toBe(409);
    expect(removed.code).toBe("APPROVAL_REVIEW_REQUIRED");
    expect(await flagRow()).toBeTruthy();

    // Step two of the chain cannot even start: the key is still taken because
    // the delete never landed.
    const recreated = await createFlagRequest(h, "flag_create_launder", LAUNDERED_FLAG);
    expect(recreated.status).toBe(400);
    expect(recreated.code).toBe("VALIDATION_ERROR");

    expect(await countApprovalReviews(h)).toBe(0);
  });

  it("leaves the served prod snapshot untouched while the request is pending", async () => {
    // The fixture seeds D1 only, so the served snapshot is planted here: a
    // gated delete must not purge it, and comparing two absent keys would
    // prove nothing.
    const sentinel = JSON.stringify({ schemaVersion: 1, sentinel: "served" });
    await h.kv.put(flagConfigKey(ids.appId, ids.environmentId, ids.flagKey), sentinel);

    const removed = await deleteFlagRequest(h, "flag_delete_snapshot");
    expect(removed.status).toBe(409);
    expect(await prodSnapshot()).toBe(sentinel);
    for (const environmentId of [ids.environmentId, ids.devEnvironmentId]) {
      expect(
        await h.repo.flags.getFlagConfig(envScope(ids.appId, environmentId), ids.flagId),
      ).toBeTruthy();
    }
  });

  it("applies the delete only through an approved Review", async () => {
    const removed = await deleteFlagRequest(h, "flag_delete_approved");
    const requestId = removed.approvalRequestId;
    expect(requestId).toBeTruthy();

    const review = await reviewRequest(h, requestId ?? "", "flag_delete_review");
    expect(review.status).toBe(200);

    expect(await flagRow()).toBeNull();
    for (const environmentId of [ids.environmentId, ids.devEnvironmentId]) {
      expect(
        await h.repo.flags.getFlagConfig(envScope(ids.appId, environmentId), ids.flagId),
      ).toBeNull();
      expect(
        await h.kv.get(flagConfigKey(ids.appId, environmentId, ids.flagKey), "text"),
      ).toBeNull();
    }
    expect(await countApprovalReviews(h)).toBe(1);
  });

  it("does not gate the delete when every Environment is `allow`", async () => {
    await h.d1
      .prepare("UPDATE environments SET policy = ? WHERE app_id = ?")
      .bind(JSON.stringify(allowPolicy), ids.appId)
      .run();

    const removed = await deleteFlagRequest(h, "flag_delete_allow");
    expect(removed.status).toBe(200);
    expect(await flagRow()).toBeNull();
    expect(await countApprovalReviews(h)).toBe(0);
  });

  it("keeps archived Experiments and Runs when a Flag delete Review is declined", async () => {
    const scope = envScope(ids.appId, ids.devEnvironmentId);
    await h.repo.experiments.experiments.insert(scope, {
      id: "exp_archived_declined_delete",
      appId: ids.appId,
      environmentId: ids.devEnvironmentId,
      key: "archived-declined-delete",
      flagId: ids.flagId,
      name: "Archived declined delete",
      status: "archived",
      targetingKeyField: "targetingKey",
      targetingKeyType: "user",
      metrics: "[]",
      guardrailMetrics: "[]",
      dimensions: "[]",
      createdAt: NOW_APPROVAL,
      updatedAt: NOW_APPROVAL,
    });
    await h.repo.experiments.runs.insert(scope, {
      id: "run_archived_declined_delete",
      appId: ids.appId,
      environmentId: ids.devEnvironmentId,
      experimentId: "exp_archived_declined_delete",
      runNumber: 1,
      status: "ended",
      targetingKeyField: "targetingKey",
      targetingKeyType: "user",
      salt: "archived-declined-delete-salt",
      allocation: JSON.stringify({ control: 100 }),
      variantSet: JSON.stringify([{ id: "variant_control", name: "control", value: false }]),
      controlVariantId: "variant_control",
      targetingRules: "[]",
      confidenceLevel: 0.95,
      decisionFamily: "[]",
      guardrailDecisions: "[]",
      configHash: "sha256:archived-declined-delete",
      startedAt: NOW_APPROVAL,
      endedAt: NOW_APPROVAL,
      createdAt: NOW_APPROVAL,
    });

    const removed = await deleteFlagRequest(h, "flag_delete_declined_archive");
    expect(removed.status).toBe(409);
    const requestId = removed.approvalRequestId;
    expect(requestId).toBeTruthy();

    const declined = await reviewRequest(h, requestId ?? "", "flag_delete_decline", "decline");
    expect(declined.status).toBe(200);

    expect(await flagRow()).toBeTruthy();
    expect(
      await h.repo.experiments.peekExperiment(scope, "exp_archived_declined_delete"),
    ).toMatchObject({
      status: "archived",
      flagId: ids.flagId,
    });
    expect(
      await h.repo.experiments.listRunsForExperiment(scope, "exp_archived_declined_delete"),
    ).toHaveLength(1);
  });
});
