import { ApprovalRequestSchema } from "@splitch/contracts";
import { type ApprovalCommit, appScope, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../src/approval-canonical";
import {
  type Harness,
  ids,
  patchFlagConfig,
  setProdPolicy,
  token,
  USER_ID,
} from "../src/config-store-harness-core";
import { appAdminScope } from "../src/scope-binding";
import { seedAppMember, seedOrgApp } from "../src/test-seeds";
import { makePoolHarness } from "./config-store-pool-harness";

let h: Harness;

const confirmPolicy = {
  variantAvailability: "confirm",
  targetingRolloutValue: "confirm",
  enabledState: "confirm",
  startExperimentRun: "confirm",
} as const;

beforeEach(async () => {
  h = await makePoolHarness();
  await setProdPolicy(h, confirmPolicy);
});

afterEach(async () => {
  await h.dispose();
});

describe("Approval Request runtime", () => {
  it("persists a proposal and exposes it through list and get", async () => {
    const requestId = await propose();

    const get = await approvalRequest("GET", requestId);
    expect(get.status).toBe(200);
    const request = ApprovalRequestSchema.parse(await get.json());
    expect(request).toMatchObject({
      id: requestId,
      appId: ids.appId,
      operation: "flag_config_update",
      status: "pending",
      target: { type: "flag_configuration", id: ids.configId },
      proposer: { userId: USER_ID, authDoor: "anonymous" },
    });
    expect(request.diff.entries).toContainEqual(
      expect.objectContaining({ path: "/availableVariantNames", operation: "replace" }),
    );
    const stored = await h.repo.approvals.getRequest(appScope(ids.appId), requestId);
    expect(stored?.diff).toBe(canonicalJson(request.diff));

    const list = await approvalRequest(
      "GET",
      undefined,
      "?status=pending&target_kind=flag_configuration",
    );
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      items: [{ id: requestId, status: "pending" }],
      cursor: null,
      total: 1,
    });
  });

  it("replays an exact proposal and conflicts on a different proposal under the same key", async () => {
    const requestId = await propose();
    expect(await propose()).toBe(requestId);

    const conflict = await patchFlagConfig(h, { enabled: true });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      code: "IDEMPOTENCY_KEY_CONFLICT",
      details: {
        scope: "approval_request",
        idempotencyKey: "idem_config_store_test",
      },
    });
  });

  it("declines durably and replays only an exact Review", async () => {
    const requestId = await propose();
    const first = await review(requestId, "decline", "idem_review_decline");
    const firstBody = await first.json();
    expect({ status: first.status, body: firstBody }).toMatchObject({ status: 200 });
    const declined = ApprovalRequestSchema.parse(firstBody);
    expect(declined).toMatchObject({
      id: requestId,
      status: "declined",
      latestReview: { outcome: "declined", action: "decline" },
    });

    const replay = await review(requestId, "decline", "idem_review_decline");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(declined);

    const conflict = await review(requestId, "approve_and_apply", "idem_review_decline");
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
  });

  it("computes stale on read without mutating, then materializes stale on Review", async () => {
    const requestId = await propose();
    await h.repo.flags.updateFlagConfig(envScope(ids.appId, ids.environmentId), ids.flagId, {
      enabled: true,
      updatedAt: "2026-07-01T21:00:00.000Z",
    });

    const read = await approvalRequest("GET", requestId);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ id: requestId, status: "stale", resolvedAt: null });
    expect(await h.repo.approvals.getRequest(appScope(ids.appId), requestId)).toMatchObject({
      status: "pending",
      resolvedAt: null,
    });

    const reviewed = await review(requestId, "approve_and_apply", "idem_review_stale");
    const reviewedBody = await reviewed.json();
    expect({ status: reviewed.status, body: reviewedBody }).toMatchObject({ status: 409 });
    expect(reviewedBody).toMatchObject({
      code: "APPROVAL_REQUEST_STALE",
      details: { approvalRequestId: requestId },
    });
    expect(await h.repo.approvals.getRequest(appScope(ids.appId), requestId)).toMatchObject({
      status: "stale",
      resolvedAt: expect.any(String),
    });
  });

  it("records a failed Review, rolls back, and permits a new idempotent retry", async () => {
    const requestId = await propose();
    await h.repo.flags.removeVariant(appScope(ids.appId), ids.flagId, "control");

    const failed = await review(requestId, "approve_and_apply", "idem_review_failed");
    expect(failed.status).toBe(409);
    expect(await failed.json()).toMatchObject({
      code: "APPROVAL_APPLICATION_FAILED",
      details: {
        approvalRequestId: requestId,
        applicationError: {
          code: "VARIANT_NOT_AVAILABLE",
          details: {
            flagId: ids.flagId,
            environmentId: ids.environmentId,
            missingVariants: ["control"],
          },
        },
      },
    });
    expect(
      await h.repo.flags.getFlagConfig(envScope(ids.appId, ids.environmentId), ids.flagId),
    ).toMatchObject({ version: 1 });
    expect(await h.repo.approvals.getRequest(appScope(ids.appId), requestId)).toMatchObject({
      status: "pending",
      resolvedAt: null,
    });

    await h.repo.flags.addVariant(appScope(ids.appId), ids.flagId, {
      id: ids.controlVariantId,
      name: "control",
      value: JSON.stringify("off"),
      createdAt: "2026-07-01T20:00:00.000Z",
    });
    const retried = await review(requestId, "approve_and_apply", "idem_review_retry");
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({
      id: requestId,
      status: "applied",
      latestReview: { outcome: "applied" },
    });
  });

  it("guards the atomic mutation against reviewer revocation and Policy drift", async () => {
    const requestId = await propose();
    const row = await h.repo.approvals.getRequest(appScope(ids.appId), requestId);
    if (!row) throw new Error("missing Approval Request");
    const commit = (reviewedBy: string, reviewId: string): ApprovalCommit => ({
      requestId,
      appId: ids.appId,
      reviewId,
      action: "approve_and_apply",
      reviewedBy,
      reviewedVia: "anonymous",
      reviewedAt: "2026-07-01T21:00:00.000Z",
      reason: null,
      idempotencyKey: reviewId,
      requestHash: `sha256:${"1".repeat(64)}`,
      resultingTargetVersion: row.targetVersion,
      resultingResourceType: "flag_configuration",
      resultingResourceId: ids.configId,
      policyContexts: JSON.parse(row.policyContexts) as ApprovalCommit["policyContexts"],
    });

    await h.repo.flags.updateFlagConfig(
      envScope(ids.appId, ids.environmentId),
      ids.flagId,
      { enabled: true, updatedAt: "2026-07-01T21:00:00.000Z" },
      commit("user_revoked", "rev_01J00000000000000000000010"),
    );
    await setProdPolicy(h, {
      ...confirmPolicy,
      enabledState: "allow",
      variantAvailability: "allow",
    });
    await h.repo.flags.updateFlagConfig(
      envScope(ids.appId, ids.environmentId),
      ids.flagId,
      { enabled: true, updatedAt: "2026-07-01T21:00:00.000Z" },
      commit(USER_ID, "rev_01J00000000000000000000011"),
    );

    expect(
      await h.repo.flags.getFlagConfig(envScope(ids.appId, ids.environmentId), ids.flagId),
    ).toMatchObject({ version: 1, enabled: false });
    expect(await h.repo.approvals.getRequest(appScope(ids.appId), requestId)).toMatchObject({
      status: "pending",
    });
    expect(await h.repo.approvals.latestReview(appScope(ids.appId), requestId)).toBeNull();
  });

  it("does not reveal or resolve an Approval Request through another Organization/App", async () => {
    const requestId = await propose();
    const attackerAppId = "app_approval_attacker";
    await seedOrgApp(h.d1, {
      orgId: "org_approval_attacker",
      orgName: "Approval Attacker",
      appId: attackerAppId,
      appName: "Approval Attacker",
      appKey: "approval-attacker",
    });
    await seedAppMember(h.d1, { appId: attackerAppId, userId: USER_ID, role: "owner" });
    const jwt = await token(h.signer, [appAdminScope(attackerAppId)]);
    const headers = { authorization: `Bearer ${jwt}` };

    const read = await h.app.request(`/apps/${attackerAppId}/approval-requests/${requestId}`, {
      headers,
    });
    expect(read.status).toBe(404);
    expect(await read.json()).toMatchObject({ code: "APPROVAL_REQUEST_NOT_FOUND" });

    const write = await h.app.request(
      `/apps/${attackerAppId}/approval-requests/${requestId}/reviews`,
      {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "idempotency-key": "idem_cross_app",
        },
        body: JSON.stringify({
          action: "decline",
          idempotency_key: "idem_cross_app",
        }),
      },
    );
    expect(write.status).toBe(404);
    expect(await h.repo.approvals.getRequest(appScope(ids.appId), requestId)).toMatchObject({
      status: "pending",
    });
  });
});

async function propose(): Promise<string> {
  const response = await patchFlagConfig(h, { availableVariantNames: ["control"] });
  expect(response.status).toBe(409);
  const body = (await response.json()) as {
    code: string;
    details: { approvalRequestId: string };
  };
  expect(body.code).toBe("APPROVAL_REVIEW_REQUIRED");
  return body.details.approvalRequestId;
}

async function approvalRequest(method: "GET", requestId?: string, query = ""): Promise<Response> {
  const jwt = await token(h.signer);
  const suffix = requestId ? `/${requestId}` : query;
  return h.app.request(`/apps/${ids.appId}/approval-requests${suffix}`, {
    method,
    headers: { authorization: `Bearer ${jwt}` },
  });
}

async function review(
  requestId: string,
  action: "approve_and_apply" | "decline",
  idempotencyKey: string,
): Promise<Response> {
  const jwt = await token(h.signer);
  return h.app.request(`/apps/${ids.appId}/approval-requests/${requestId}/reviews`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify({ action, idempotency_key: idempotencyKey }),
  });
}
