import { appScope, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Harness,
  ids,
  patchFlagConfig,
  setProdPolicy,
  token,
  USER_ID,
} from "../src/config-store-harness-core";
import {
  auditRequest,
  auditRows,
  CANARIES,
  expectPrivateAudit,
} from "./app-audit-mutation-fixture";
import {
  confirmPolicy,
  countApprovalReviews,
  getApprovalRequests,
  proposeA,
  removeVariantAfterClearingRules,
} from "./approval-harness";
import { makePoolHarness } from "./config-store-pool-harness";

let h: Harness;
let jwt: string;
beforeEach(async () => {
  h = await makePoolHarness();
  jwt = await token(h.signer);
  await setProdPolicy(h, confirmPolicy);
});
afterEach(async () => h.dispose());

function review(id: string, key: string, action = "approve_and_apply") {
  return auditRequest({
    app: h.app,
    jwt,
    path: `/apps/${ids.appId}/approval-requests/${id}/reviews`,
    requestId: `request_${key}`,
    idempotencyKey: key,
    body: { idempotency_key: key, action, reason: CANARIES.reason },
  });
}

describe("Approval audit records committed Reviews rather than HTTP success", () => {
  it.each(["applied", "declined", "stale", "failed"] as const)(
    "records a %s Review once and excludes exact replay and conflicts",
    async (outcome) => {
      const before = await auditRows(h.repo, ids.appId);
      const id = await proposeA(h);
      const pending = await h.repo.approvals.getRequest(appScope(ids.appId), id);
      const proposed = (await auditRows(h.repo, ids.appId)).slice(before.length);
      expect(proposed).toHaveLength(1);
      expect(proposed[0]).toMatchObject({
        action: "flag_config_update",
        resourceType: "approval_request",
        resourceId: id,
        approvalRequestId: id,
        targetVersion: pending?.targetVersion,
        outcome: "pending",
        actorRef: USER_ID,
        actorVia: "anonymous",
        environmentId: ids.environmentId,
        organizationId: ids.orgId,
      });
      // SHA-256 of version 1 plus the single confirm/variant_availability Policy projection.
      expect(pending?.targetVersion).toBe(
        "sha256:0a6426c5dc20daced1c7644ff0b2fa205acd869d54c805d1fc5449cb1e426772",
      );
      expect(proposed[0]?.requestId).toEqual(expect.any(String));
      expect(await proposeA(h)).toBe(id);
      expect((await auditRows(h.repo, ids.appId)).slice(before.length)).toEqual(proposed);

      await prepareReviewOutcome(outcome, id);
      expect((await auditRows(h.repo, ids.appId)).slice(before.length)).toEqual(proposed);
      const configBefore = await h.repo.flags.getFlagConfig(
        envScope(ids.appId, ids.environmentId),
        ids.flagId,
      );
      const action = outcome === "declined" ? "decline" : "approve_and_apply";
      const key = `review-${outcome}`;
      const response = await review(id, key, action);
      expect(response.status, await response.clone().text()).toBe(
        outcome === "failed" || outcome === "stale" ? 409 : 200,
      );
      const stored = await h.repo.approvals.latestReview(appScope(ids.appId), id);
      expect(stored).toMatchObject({ outcome });
      expect(await countApprovalReviews(h)).toBe(1);
      const rows = (await auditRows(h.repo, ids.appId)).slice(before.length);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({
        action: "approval_request_reviews_create",
        resourceType: "approval_request",
        resourceId: id,
        approvalRequestId: id,
        targetVersion: pending?.targetVersion,
        outcome,
        requestId: `request_${key}`,
        actorRef: USER_ID,
        actorVia: "anonymous",
        environmentId: ids.environmentId,
      });
      expect(JSON.parse(rows[1]?.changesJson ?? "null")).toMatchObject({
        reviewId: stored?.id,
        reviewAction: action,
        errorCode: stored?.errorCode ?? null,
      });
      await expectTargetMutation(outcome, id, configBefore, rows[1]?.changesJson ?? "null");

      const replay = await review(id, key, action);
      expect(replay.status).toBe(response.status);
      expect(await auditRows(h.repo, ids.appId)).toEqual([...before, ...rows]);
      expect(await countApprovalReviews(h)).toBe(1);
      const conflict = await review(
        id,
        key,
        action === "decline" ? "approve_and_apply" : "decline",
      );
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
      expect(await auditRows(h.repo, ids.appId)).toEqual([...before, ...rows]);
      expectPrivateAudit(rows, jwt);
    },
  );

  it("does not record refusal before a Review or an idempotency-conflicting proposal", async () => {
    const id = await proposeA(h);
    const before = await auditRows(h.repo, ids.appId);
    const missing = await review("apr_01J00000000000000000000000", "missing-request");
    expect(missing.status).toBe(404);
    const malformed = await review(id, "invalid-review", "not_an_action");
    expect(malformed.status).toBe(400);
    const conflict = await patchFlagConfig(h, { enabled: true });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
    expect(await countApprovalReviews(h)).toBe(0);
    expect(await auditRows(h.repo, ids.appId)).toEqual(before);
  });
});

async function prepareReviewOutcome(outcome: string, id: string) {
  if (outcome === "failed") await removeVariantAfterClearingRules(h, "control");
  if (outcome !== "stale") return;
  await h.repo.flags.updateFlagConfig(envScope(ids.appId, ids.environmentId), ids.flagId, {
    enabled: true,
    updatedAt: "2026-07-01T21:00:00.000Z",
  });
  const read = await getApprovalRequests(h, id);
  expect(await read.json()).toMatchObject({ status: "stale", resolvedAt: null });
}

async function expectTargetMutation(
  outcome: string,
  id: string,
  before: Awaited<ReturnType<Harness["repo"]["flags"]["getFlagConfig"]>>,
  metadata: string,
) {
  const request = await h.repo.approvals.getRequest(appScope(ids.appId), id);
  const after = await h.repo.flags.getFlagConfig(
    envScope(ids.appId, ids.environmentId),
    ids.flagId,
  );
  if (outcome === "applied") {
    expect(after?.version).toBe((before?.version ?? 0) + 1);
    expect(JSON.parse(metadata).resultingTargetVersion).toBe(request?.resultingTargetVersion);
    // The same Policy projection at committed Configuration version 2.
    expect(request?.resultingTargetVersion).toBe(
      "sha256:e1c5f2eef37859eff29fcf4d9b86d009254bbabac0a39e613dd7857d4d6b27ef",
    );
  } else expect(after).toEqual(before);
  if (outcome === "failed") expect(request).toMatchObject({ status: "pending", resolvedAt: null });
}
