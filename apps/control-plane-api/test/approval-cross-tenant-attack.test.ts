/**
 * Cross-tenant / authz attacks on the Approval runtime, kept as a permanent
 * regression suite. Tenant B uses DELIBERATELY DISTINCT seeds from tenant A so
 * that any leakage shows up as a foreign value, never as a coincidentally-equal
 * fixture: identical seeds on both sides mask isolation bugs by construction.
 */
import { appScope, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, ids, setProdPolicy, token, USER_ID } from "../src/config-store-harness-core";
import { appAdminScope } from "../src/scope-binding";
import { seedAppMember } from "../src/test-seeds";
import { confirmPolicy, proposeA } from "./approval-harness";
import { B, get, jwtFor, proposeB, reviewAs, seedTenantB } from "./approval-tenant-b";
import { makePoolHarness } from "./config-store-pool-harness";

let h: Harness;

beforeEach(async () => {
  h = await makePoolHarness();
  await setProdPolicy(h, confirmPolicy);
  await seedTenantB(h);
});

afterEach(async () => {
  await h.dispose();
});

describe("ATTACK: cross-Organization approval reads", () => {
  it("A1: victim path + attacker-only scope is refused (no membership in victim App)", async () => {
    const requestId = await proposeA(h);
    const jwt = await jwtFor(h, B.userId, [appAdminScope(B.appId)]);

    const single = await get(h, `/apps/${ids.appId}/approval-requests/${requestId}`, jwt);
    expect(single.status).toBeGreaterThanOrEqual(400);
    expect(await single.text()).not.toContain(ids.configId);

    const list = await get(h, `/apps/${ids.appId}/approval-requests`, jwt);
    expect(list.status).toBeGreaterThanOrEqual(400);
    expect(await list.text()).not.toContain(requestId);
  });

  it("A2: victim path + FORGED victim scope but no membership is refused", async () => {
    const requestId = await proposeA(h);
    // A valid IdP-signed token that claims the victim App's admin scope. Membership
    // is the only thing standing between this token and the victim's data.
    const jwt = await jwtFor(h, B.userId, [appAdminScope(ids.appId)]);

    const single = await get(h, `/apps/${ids.appId}/approval-requests/${requestId}`, jwt);
    expect(single.status).toBe(403);
    const list = await get(h, `/apps/${ids.appId}/approval-requests`, jwt);
    expect(list.status).toBe(403);

    const write = await reviewAs(h, ids.appId, requestId, jwt, "approve_and_apply", "idem_a2_9271");
    expect(write.status).toBe(403);
    expect(await h.repo.approvals.getRequest(appScope(ids.appId), requestId)).toMatchObject({
      status: "pending",
    });
    expect(await h.repo.approvals.latestReview(appScope(ids.appId), requestId)).toBeNull();
    expect(
      await h.repo.flags.getFlagConfig(envScope(ids.appId, ids.environmentId), ids.flagId),
    ).toMatchObject({ version: 1 });
  });

  it("A3: list is App-scoped -- B's list never contains A's request and vice versa", async () => {
    const requestA = await proposeA(h);
    const requestB = await proposeB(h);
    expect(requestA).not.toBe(requestB);

    const bJwt = await jwtFor(h, B.userId, [appAdminScope(B.appId)]);
    const bList = await get(h, `/apps/${B.appId}/approval-requests`, bJwt);
    expect(bList.status).toBe(200);
    const bText = await bList.text();
    expect(bText).toContain(requestB);
    expect(bText).not.toContain(requestA);
    expect(bText).not.toContain(ids.configId);
    expect(bText).not.toContain(ids.appId);

    const aJwt = await token(h.signer);
    const aList = await get(h, `/apps/${ids.appId}/approval-requests`, aJwt);
    expect(aList.status).toBe(200);
    const aText = await aList.text();
    expect(aText).toContain(requestA);
    expect(aText).not.toContain(requestB);
    expect(aText).not.toContain(B.configId);
    expect(aText).not.toContain(B.appId);
  });
});

describe("ATTACK: cross-App approval writes", () => {
  it("A4: dual-member cannot review A's request through B's App path", async () => {
    const requestA = await proposeA(h);
    // Attacker is a legitimate owner of BOTH Apps (the strongest realistic actor).
    await seedAppMember(h.d1, { appId: B.appId, userId: USER_ID, role: "owner" });
    const jwt = await jwtFor(h, USER_ID, [appAdminScope(B.appId)]);

    const response = await reviewAs(h, B.appId, requestA, jwt, "approve_and_apply", "idem_a4_9271");
    expect(response.status).toBe(404);
    expect(await h.repo.approvals.getRequest(appScope(ids.appId), requestA)).toMatchObject({
      status: "pending",
    });
    expect(await h.repo.approvals.latestReview(appScope(ids.appId), requestA)).toBeNull();
    expect(await h.repo.approvals.latestReview(appScope(B.appId), requestA)).toBeNull();
    expect(
      await h.repo.flags.getFlagConfig(envScope(ids.appId, ids.environmentId), ids.flagId),
    ).toMatchObject({ version: 1, availableVariantNames: '["control","treatment"]' });
  });

  it("A5: B's request cannot be applied through A's App path", async () => {
    const requestB = await proposeB(h);
    const jwt = await token(h.signer); // A's owner, A admin scope

    const response = await reviewAs(
      h,
      ids.appId,
      requestB,
      jwt,
      "approve_and_apply",
      "idem_a5_9271",
    );
    expect(response.status).toBe(404);
    expect(await h.repo.approvals.getRequest(appScope(B.appId), requestB)).toMatchObject({
      status: "pending",
    });
    expect(await h.repo.flags.getFlagConfig(envScope(B.appId, B.envId), B.flagId)).toMatchObject({
      version: 1,
      availableVariantNames: '["beta-alpha","beta-omega"]',
    });
  });

  it("A6: non-admin member cannot review, and nothing mutates", async () => {
    const requestId = await proposeA(h);
    const memberId = "user_lowpriv_9271";
    await seedAppMember(h.d1, { appId: ids.appId, userId: memberId, role: "member" });

    // Best case for the attacker: a token that also claims the admin scope.
    const jwt = await jwtFor(h, memberId, [appAdminScope(ids.appId), `app:${ids.appId}:member`]);
    const response = await reviewAs(
      h,
      ids.appId,
      requestId,
      jwt,
      "approve_and_apply",
      "idem_a6_9271",
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await h.repo.approvals.getRequest(appScope(ids.appId), requestId)).toMatchObject({
      status: "pending",
    });
    expect(await h.repo.approvals.latestReview(appScope(ids.appId), requestId)).toBeNull();
    expect(
      await h.repo.flags.getFlagConfig(envScope(ids.appId, ids.environmentId), ids.flagId),
    ).toMatchObject({ version: 1 });
  });
});

describe("ATTACK: stale membership", () => {
  it("A7: revoked App membership cannot review with a still-valid session token", async () => {
    const requestId = await proposeA(h);
    await h.d1
      .prepare("DELETE FROM app_memberships WHERE app_id = ? AND user_id = ?")
      .bind(ids.appId, USER_ID)
      .run();

    const jwt = await token(h.signer); // unexpired, still claims app admin scope
    const response = await reviewAs(
      h,
      ids.appId,
      requestId,
      jwt,
      "approve_and_apply",
      "idem_a7_9271",
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await h.repo.approvals.getRequest(appScope(ids.appId), requestId)).toMatchObject({
      status: "pending",
    });
    expect(await h.repo.approvals.latestReview(appScope(ids.appId), requestId)).toBeNull();
    expect(
      await h.repo.flags.getFlagConfig(envScope(ids.appId, ids.environmentId), ids.flagId),
    ).toMatchObject({ version: 1 });

    const read = await get(h, `/apps/${ids.appId}/approval-requests/${requestId}`, jwt);
    expect(read.status).toBeGreaterThanOrEqual(400);
  });

  it("A8: demotion owner -> member between proposal and review blocks the apply", async () => {
    const requestId = await proposeA(h);
    await h.d1
      .prepare("UPDATE app_memberships SET role = 'member' WHERE app_id = ? AND user_id = ?")
      .bind(ids.appId, USER_ID)
      .run();

    const jwt = await token(h.signer);
    const response = await reviewAs(
      h,
      ids.appId,
      requestId,
      jwt,
      "approve_and_apply",
      "idem_a8_9271",
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(
      await h.repo.flags.getFlagConfig(envScope(ids.appId, ids.environmentId), ids.flagId),
    ).toMatchObject({ version: 1 });
    expect(await h.repo.approvals.latestReview(appScope(ids.appId), requestId)).toBeNull();
  });
});
