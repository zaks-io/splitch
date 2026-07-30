import { type ApprovalCommit, appScope, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, ids, setProdPolicy, token, USER_ID } from "../src/config-store-harness-core";
import { appAdminScope } from "../src/scope-binding";
import { seedAppMember, seedOrgApp } from "../src/test-seeds";
import { confirmPolicy, getApprovalRequests, proposeA } from "./approval-harness";
import { makePoolHarness } from "./config-store-pool-harness";

let h: Harness;

beforeEach(async () => {
  h = await makePoolHarness();
  await setProdPolicy(h, confirmPolicy);
});

afterEach(async () => {
  await h.dispose();
});

describe("Approval Request runtime: atomic guards and tenant isolation", () => {
  it("guards the atomic mutation against reviewer revocation and Policy drift", async () => {
    const requestId = await proposeA(h);
    const row = await h.repo.approvals.getRequest(appScope(ids.appId), requestId);
    if (!row) throw new Error("missing Approval Request");
    const commit = (reviewedBy: string, reviewId: string): ApprovalCommit => ({
      requestId,
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
    const requestId = await proposeA(h);
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

    // Positive control: the same request id IS readable in its own App, so a 404
    // below is App scoping and not an inert endpoint or an empty table.
    const own = await getApprovalRequests(h, requestId);
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({ id: requestId });

    const read = await h.app.request(`/apps/${attackerAppId}/approval-requests/${requestId}`, {
      headers,
    });
    expect(read.status).toBe(404);
    expect(await read.json()).toMatchObject({ code: "APPROVAL_REQUEST_NOT_FOUND" });

    // The attacker's list must not leak the victim's request either.
    const attackerList = await h.app.request(`/apps/${attackerAppId}/approval-requests`, {
      headers,
    });
    expect(attackerList.status).toBe(200);
    expect(await attackerList.json()).toMatchObject({ items: [], total: 0 });

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
