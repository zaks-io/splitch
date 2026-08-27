import { appScope, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, ids, setProdPolicy } from "../src/config-store-harness-core";
import {
  allowPolicy,
  clearFrozenRun,
  confirmPolicy,
  countApprovalReviews,
  createVariantRequest,
  deleteVariantRequest,
  patchVariant,
  reviewRequest,
} from "./approval-harness";
import { makePoolHarness } from "./config-store-pool-harness";

/**
 * An EMPTY `available_variant_names` is the production default: a Configuration
 * that was never narrowed serves the Flag's whole catalog. While the fixtures
 * all seeded an explicit list, that default hid the fact that catalog
 * membership (POST / DELETE on `/variants`) was ungated: DELETE the Variant,
 * POST it back with a different value, and a value change the gate refuses
 * head-on lands in three calls with zero Reviews.
 */

let h: Harness;

beforeEach(async () => {
  h = await makePoolHarness();
  await setProdPolicy(h, confirmPolicy);
  await clearFrozenRun(h);
  // These cases prove available-set emptiness, not Targeting Rule references.
  // The seeded dev rule points at treatment; leave it in place and the delete
  // is refused for a different reason than the one under test.
  await h.d1
    .prepare("DELETE FROM targeting_rules WHERE app_id = ? AND flag_id = ?")
    .bind(ids.appId, ids.flagId)
    .run();
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

function treatment() {
  return h.repo.flags.getVariantById(appScope(ids.appId), ids.treatmentVariantId);
}

describe("catalog membership is gated where the Environment was never narrowed", () => {
  it("closes the delete-then-recreate laundering chain", async () => {
    const direct = await patchVariant(h, "treatment", "cat_direct", { value: "pwned" });
    expect(direct.code).toBe("APPROVAL_REVIEW_REQUIRED");

    const removed = await deleteVariantRequest(h, "treatment", "cat_delete");
    expect(removed.status).toBe(409);
    expect(removed.code).toBe("APPROVAL_REVIEW_REQUIRED");
    expect((await treatment())?.value).toBe(JSON.stringify("on"));

    // The DELETE never landed, so step three of the chain cannot even reach the
    // gate: the name is still taken. A create under a free name is gated too,
    // which the next test proves directly.
    const recreated = await createVariantRequest(h, "cat_create", {
      name: "treatment",
      value: "pwned",
    });
    expect(recreated.status).toBe(400);
    expect(recreated.code).toBe("VALIDATION_ERROR");

    const variant = await treatment();
    expect(variant?.name).toBe("treatment");
    expect(variant?.value).toBe(JSON.stringify("on"));
    expect(await countApprovalReviews(h)).toBe(0);
  });

  it("gates a brand-new catalog Variant, which every Environment would serve", async () => {
    const created = await createVariantRequest(h, "cat_beta", { name: "beta", value: "beta-on" });
    expect(created.status).toBe(409);
    expect(created.code).toBe("APPROVAL_REVIEW_REQUIRED");
    expect(await h.repo.flags.getVariantByName(appScope(ids.appId), ids.flagId, "beta")).toBeNull();
  });

  it("writes the Variant only when the create is approved", async () => {
    const created = await createVariantRequest(h, "cat_beta2", { name: "beta", value: "beta-on" });
    const applied = await reviewRequest(h, created.approvalRequestId as string, "cat_beta2r");
    expect(applied.status).toBe(200);

    const beta = await h.repo.flags.getVariantByName(appScope(ids.appId), ids.flagId, "beta");
    expect(beta?.value).toBe(JSON.stringify("beta-on"));
    expect(await countApprovalReviews(h)).toBe(1);
  });

  it("removes the Variant only when the delete is approved", async () => {
    const removed = await deleteVariantRequest(h, "treatment", "cat_del2");
    const applied = await reviewRequest(h, removed.approvalRequestId as string, "cat_del2r");
    expect(applied.status).toBe(200);

    expect(await treatment()).toBeNull();
    expect(await countApprovalReviews(h)).toBe(1);
  });
});

describe("an ungated catalog create is idempotent", () => {
  it("a retry under the same key replays instead of colliding on the name", async () => {
    await setProdPolicy(h, allowPolicy);
    const created = await createVariantRequest(h, "cat_idem", { name: "beta", value: "beta-on" });
    expect(created.status).toBe(200);

    const retried = await createVariantRequest(h, "cat_idem", { name: "beta", value: "beta-on" });
    expect(retried.status).toBe(200);

    const betas = (await h.repo.flags.listVariants(appScope(ids.appId), ids.flagId)).filter(
      (variant) => variant.name === "beta",
    );
    expect(betas.length).toBe(1);
  });
});

describe("the delete guard reads explicit references, not servability", () => {
  it("allows an ungated delete when no Environment names the Variant", async () => {
    await setProdPolicy(h, allowPolicy);
    const removed = await deleteVariantRequest(h, "treatment", "cat_del3");
    expect(removed.status).toBe(200);
    expect(await treatment()).toBeNull();
  });

  it("still refuses to delete a Variant an Environment lists by name", async () => {
    await setProdPolicy(h, allowPolicy);
    await h.repo.flags.updateFlagConfig(envScope(ids.appId, ids.environmentId), ids.flagId, {
      availableVariantNames: JSON.stringify(["control", "treatment"]),
      updatedAt: "2026-07-02T09:30:00.000Z",
    });

    const removed = await deleteVariantRequest(h, "treatment", "cat_del4");
    expect(removed.status).toBe(409);
    expect(removed.code).toBe("RESOURCE_NOT_EMPTY");
    expect(await treatment()).not.toBeNull();
  });
});
