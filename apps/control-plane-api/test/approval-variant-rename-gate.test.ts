import { appScope, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, ids, setProdPolicy } from "../src/config-store-harness-core";
import {
  allowPolicy,
  clearFrozenRun,
  confirmPolicy,
  countApprovalReviews,
  patchConfig,
  patchVariant,
  reviewRequest,
} from "./approval-harness";
import { makePoolHarness } from "./config-store-pool-harness";

/**
 * A Variant rename changes what an Environment serves: `available_variant_names`
 * and targeting rules key off the NAME. While the rename was ungated, three
 * ungated calls (rename away from the servable name, edit the value while the
 * Variant was un-servable, rename back) landed a value change the Approval gate
 * refuses when asked directly. The rename is now gated by `variant_availability`
 * and must carry the available set with it in the same transaction.
 */

let h: Harness;

beforeEach(async () => {
  h = await makePoolHarness();
  await setProdPolicy(h, confirmPolicy);
  await clearFrozenRun(h);
  await h.repo.flags.updateFlagConfig(envScope(ids.appId, ids.environmentId), ids.flagId, {
    enabled: true,
    updatedAt: "2026-07-02T09:00:00.000Z",
  });
});

afterEach(async () => {
  await h.dispose();
});

async function availableNames(envId: string): Promise<unknown> {
  const config = await h.repo.flags.getFlagConfig(envScope(ids.appId, envId), ids.flagId);
  return JSON.parse(config?.availableVariantNames ?? "[]");
}

describe("rename-then-edit cannot bypass the Variant value Approval gate", () => {
  it("stops at the rename, which is itself gated", async () => {
    const direct = await patchVariant(h, "treatment", "d1_direct", { value: "direct-attempt" });
    expect(direct.code).toBe("APPROVAL_REVIEW_REQUIRED");

    // Step 1 of the chain: rename away from the name listed in
    // available_variant_names. This used to be free.
    const away = await patchVariant(h, "treatment", "d1_away", { name: "tmp-shadow" });
    expect(away.code).toBe("APPROVAL_REVIEW_REQUIRED");

    // Step 2 therefore has no shadow name to address, and the Variant is still
    // servable under its real name, so the value edit stays gated.
    const shadowed = await patchVariant(h, "tmp-shadow", "d1_value", { value: "pwned-d1" });
    expect(shadowed.status).toBe(404);
    const value = await patchVariant(h, "treatment", "d1_value2", { value: "pwned-d1" });
    expect(value.code).toBe("APPROVAL_REVIEW_REQUIRED");

    const variant = await h.repo.flags.getVariantById(appScope(ids.appId), ids.treatmentVariantId);
    expect(variant?.name).toBe("treatment");
    expect(variant?.value).toBe(JSON.stringify("on"));
    expect(await countApprovalReviews(h)).toBe(0);
  });
});

describe("a Variant rename is gated by variant_availability", () => {
  it("renaming a servable Variant opens an Approval Request instead of applying", async () => {
    const renamed = await patchVariant(h, "treatment", "idem_c4", { name: "renamed-c4" });
    expect(renamed.code).toBe("APPROVAL_REVIEW_REQUIRED");

    const variant = await h.repo.flags.getVariantById(appScope(ids.appId), ids.treatmentVariantId);
    expect(variant?.name).toBe("treatment");
    expect(await availableNames(ids.environmentId)).toEqual(["control", "treatment"]);
  });

  it("an approved rename rewrites available_variant_names in the same transaction", async () => {
    const renamed = await patchVariant(h, "treatment", "idem_c4b", { name: "renamed-c4b" });
    const applied = await reviewRequest(h, renamed.approvalRequestId as string, "idem_c4br");
    expect(applied.status).toBe(200);

    const variant = await h.repo.flags.getVariantById(appScope(ids.appId), ids.treatmentVariantId);
    expect(variant?.name).toBe("renamed-c4b");
    for (const envId of [ids.environmentId, ids.devEnvironmentId]) {
      expect(await availableNames(envId)).toEqual(["control", "renamed-c4b"]);
    }
  });

  it("makes a pending flag_configuration proposal stale, not a retry-forever failure", async () => {
    // The rewrite is a write to flag_configs. Without the version bump the
    // pending config proposal stayed `pending`, the optimistic version guard
    // could not see the write, and the apply answered
    // APPROVAL_APPLICATION_FAILED / RETRY_REVIEW — a retry that can never work.
    const config = await patchConfig(h, "idem_c4d", { availableVariantNames: ["control"] });
    expect(config.code).toBe("APPROVAL_REVIEW_REQUIRED");

    const renamed = await patchVariant(h, "treatment", "idem_c4d2", { name: "renamed-c4d" });
    expect((await reviewRequest(h, renamed.approvalRequestId as string, "idem_c4d2r")).status).toBe(
      200,
    );

    const applied = await reviewRequest(h, config.approvalRequestId as string, "idem_c4dr");
    expect(applied.status).toBeGreaterThanOrEqual(400);
    expect(await applied.json()).toMatchObject({
      code: "APPROVAL_REQUEST_STALE",
      details: { recommendedAction: "REFRESH_AND_REPROPOSE" },
    });
  });

  it("an ungated rename still rewrites available_variant_names", async () => {
    await setProdPolicy(h, allowPolicy);
    const renamed = await patchVariant(h, "treatment", "idem_c4c", { name: "renamed-c4c" });
    expect(renamed.status).toBe(200);

    for (const envId of [ids.environmentId, ids.devEnvironmentId]) {
      expect(await availableNames(envId)).toEqual(["control", "renamed-c4c"]);
    }
  });
});
