/**
 * Attacks on the seam between validating an Approval Request's target version
 * and applying it, plus the audit trail left by the deliberately ungated
 * kill-switch path. Kept as a permanent regression suite alongside
 * `approval-cross-tenant-attack.test.ts`.
 */
import { appScope, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { narrowSeededAvailability } from "../src/config-store-fixture-data";
import { type Harness, ids, setProdPolicy } from "../src/config-store-harness-core";
import {
  clearFrozenRun,
  confirmPolicy,
  countApprovalReviews,
  insertEnvironment,
  insertFlagConfig,
  outOfContractPolicy,
  patchConfig,
  patchVariant,
  reviewRequest,
} from "./approval-harness";
import { makePoolHarness } from "./config-store-pool-harness";

let h: Harness;

beforeEach(async () => {
  h = await makePoolHarness();
  // The fixture ships `[]` (never narrowed), matching `ensureInitialFlagConfig`.
  // This suite asserts on the available-Variant list itself, so it narrows
  // explicitly instead of leaning on a fixture default.
  await narrowSeededAvailability(h.d1);
  await setProdPolicy(h, confirmPolicy);
});

afterEach(async () => {
  await h.dispose();
});

async function proposeConfig(key: string): Promise<string> {
  const proposed = await patchConfig(h, key, { availableVariantNames: ["control"] });
  expect(proposed.code).toBe("APPROVAL_REVIEW_REQUIRED");
  return proposed.approvalRequestId as string;
}

describe("ATTACK: TOCTOU between target-version validation and apply", () => {
  it("A11: target moved after the version check -> no mutation, request goes stale", async () => {
    const requestId = await proposeConfig("idem_a11_9271");
    // Move the target the way a concurrent legitimate writer would.
    await h.repo.flags.updateFlagConfig(envScope(ids.appId, ids.environmentId), ids.flagId, {
      rollout: JSON.stringify({ percentage: 11, salt: "attack9271" }),
      updatedAt: "2026-07-02T12:00:00.000Z",
    });
    const before = await h.repo.flags.getFlagConfig(
      envScope(ids.appId, ids.environmentId),
      ids.flagId,
    );

    const response = await reviewRequest(h, requestId, "idem_a11r_9271");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "APPROVAL_REQUEST_STALE" });

    const after = await h.repo.flags.getFlagConfig(
      envScope(ids.appId, ids.environmentId),
      ids.flagId,
    );
    expect(after).toEqual(before);
    const row = await h.repo.approvals.getRequest(appScope(ids.appId), requestId);
    expect(row?.status).toBe("stale");
    // A stale request must never carry an application result.
    expect(row?.resultingTargetVersion).toBeNull();
    expect(row?.resultingResourceId).toBeNull();
  });

  it("A12: a reserved `approve` level smuggled into D1 cannot be self-applied", async () => {
    const requestId = await proposeConfig("idem_a12_9271");
    await h.d1
      .prepare("UPDATE environments SET policy = ? WHERE id = ?")
      .bind(JSON.stringify(outOfContractPolicy), ids.environmentId)
      .run();

    const response = await reviewRequest(h, requestId, "idem_a12r_9271");
    expect(response.status).toBeGreaterThanOrEqual(400);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe("INTERNAL_SERVER_ERROR");
    expect(body.message).toContain("stored Environment Policy is out of contract");
    expect(
      await h.repo.flags.getFlagConfig(envScope(ids.appId, ids.environmentId), ids.flagId),
    ).toMatchObject({ version: 1, availableVariantNames: '["control","treatment"]' });
  });

  it("A13: a NEW stricter Environment added after proposal must invalidate a Variant proposal", async () => {
    // The App-level Variant value token must cover every Environment where the
    // Variant is servable (storage-schemas-d1.md). A new Environment where it is
    // servable is a vector change and must make the proposal stale.
    await clearFrozenRun(h);
    const proposed = await patchVariant(h, "treatment", "idem_a13_9271", {
      value: "escalated-9271",
    });
    expect(proposed.code).toBe("APPROVAL_REVIEW_REQUIRED");

    // Governance widens: a new Environment where this Variant is servable and
    // whose Policy the frozen contexts never covered.
    await insertEnvironment(h, "env_strict_9271", confirmPolicy);
    await insertFlagConfig(h, "env_strict_9271");

    const response = await reviewRequest(h, proposed.approvalRequestId as string, "idem_a13r_9271");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "APPROVAL_REQUEST_STALE" });
    // If this applied, the proposal would have been approved against a Policy
    // vector that no longer describes where the Variant is servable.
    const variant = await h.repo.flags.getVariantById(appScope(ids.appId), ids.treatmentVariantId);
    expect(variant?.value).toBe(JSON.stringify("on"));
  });
});

describe("ATTACK: audit trail on the ungated (kill-switch) path", () => {
  it("A14: kill-switch-off bypasses Approval -- record what audit remains", async () => {
    await h.repo.flags.updateFlagConfig(envScope(ids.appId, ids.environmentId), ids.flagId, {
      enabled: true,
      updatedAt: "2026-07-02T09:00:00.000Z",
    });
    const response = await patchConfig(h, "idem_a14_9271", { enabled: false });
    expect(response.status).toBe(200);
    const config = await h.repo.flags.getFlagConfig(
      envScope(ids.appId, ids.environmentId),
      ids.flagId,
    );
    expect(config?.enabled).toBe(false);

    // Turning a Flag OFF is an availability reduction and is deliberately
    // ungated, so it opens no Approval Request and records no Review.
    expect((await h.repo.approvals.listRequests(appScope(ids.appId))).length).toBe(0);
    expect(await countApprovalReviews(h)).toBe(0);
  });

  it("A15: a Variant RENAME is gated, because serving keys off the NAME", async () => {
    // available_variant_names and targeting rules key off the Variant name, so a
    // rename changes what an Environment serves and belongs under the same
    // variant_availability gate as promoting a Variant into that Environment.
    const renamed = await patchVariant(h, "treatment", "idem_a15_9271", { name: "renamed-9271" });
    expect(renamed.status).toBe(409);
    expect(renamed.code).toBe("APPROVAL_REVIEW_REQUIRED");

    const config = await h.repo.flags.getFlagConfig(
      envScope(ids.appId, ids.environmentId),
      ids.flagId,
    );
    expect(config?.availableVariantNames).toBe('["control","treatment"]');
    const variant = await h.repo.flags.getVariantById(appScope(ids.appId), ids.treatmentVariantId);
    expect(variant?.name).toBe("treatment");
  });
});
