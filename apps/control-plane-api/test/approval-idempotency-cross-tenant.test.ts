/**
 * Idempotency-key replay across tenants. A key is only unique within an App, so
 * a shared key must never let one tenant's proposal or Review resolve another's.
 * Tenant B uses DELIBERATELY DISTINCT seeds from tenant A so that leakage shows
 * up as a foreign value, never as a coincidentally-equal fixture.
 */
import { appScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, ids, setProdPolicy, token, USER_ID } from "../src/config-store-harness-core";
import { appAdminScope } from "../src/scope-binding";
import { seedAppMember } from "../src/test-seeds";
import { confirmPolicy, proposeA } from "./approval-harness";
import { B, jwtFor, proposeB, reviewAs, seedTenantB } from "./approval-tenant-b";
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

describe("ATTACK: idempotency key replay across tenants", () => {
  it("A9: the same actor + same key in two Apps yields two independent requests", async () => {
    const dualUser = USER_ID;
    await seedAppMember(h.d1, { appId: B.appId, userId: dualUser, role: "owner" });
    const sharedKey = "idem_shared_across_tenants_9271";

    const aJwt = await jwtFor(h, dualUser, [appAdminScope(ids.appId)]);
    const aResponse = await h.app.request(
      `/apps/${ids.appId}/envs/${ids.environmentId}/flags/${ids.flagId}/config`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${aJwt}`,
          "content-type": "application/json",
          "idempotency-key": sharedKey,
        },
        body: JSON.stringify({
          idempotency_key: sharedKey,
          availableVariantNames: ["control"],
        }),
      },
    );
    expect(aResponse.status).toBe(409);
    const aBody = (await aResponse.json()) as { details: { approvalRequestId: string } };

    const bJwt = await jwtFor(h, dualUser, [appAdminScope(B.appId)]);
    const bResponse = await h.app.request(
      `/apps/${B.appId}/envs/${B.envId}/flags/${B.flagId}/config`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${bJwt}`,
          "content-type": "application/json",
          "idempotency-key": sharedKey,
        },
        body: JSON.stringify({
          idempotency_key: sharedKey,
          availableVariantNames: ["beta-alpha"],
        }),
      },
    );
    // Must NOT be an idempotent replay of A's request, and must NOT 409-conflict
    // on a key that is only unique within an App.
    expect(bResponse.status).toBe(409);
    const bBody = (await bResponse.json()) as {
      code: string;
      details: { approvalRequestId?: string };
    };
    expect(bBody.code).toBe("APPROVAL_REVIEW_REQUIRED");
    expect(bBody.details.approvalRequestId).not.toBe(aBody.details.approvalRequestId);

    const aRow = await h.repo.approvals.getRequest(
      appScope(ids.appId),
      aBody.details.approvalRequestId,
    );
    const bRow = await h.repo.approvals.getRequest(
      appScope(B.appId),
      bBody.details.approvalRequestId as string,
    );
    expect(aRow?.targetId).toBe(ids.configId);
    expect(bRow?.targetId).toBe(B.configId);
  });

  it("A10: a review idempotency key from A cannot resolve B's request", async () => {
    const requestA = await proposeA(h);
    const requestB = await proposeB(h);
    const aJwt = await token(h.signer);
    const applied = await reviewAs(
      h,
      ids.appId,
      requestA,
      aJwt,
      "approve_and_apply",
      "idem_review_shared_9271",
    );
    expect(applied.status).toBe(200);

    // Same actor identity string, same review key, B's request id, B's App path.
    await seedAppMember(h.d1, { appId: B.appId, userId: USER_ID, role: "owner" });
    const bJwt = await jwtFor(h, USER_ID, [appAdminScope(B.appId)]);
    const cross = await reviewAs(
      h,
      B.appId,
      requestB,
      bJwt,
      "approve_and_apply",
      "idem_review_shared_9271",
    );
    // Legitimate (B owner reviewing B's request) -- assert it did NOT replay A's
    // recorded review, which would silently skip B's target validation.
    const bReview = await h.repo.approvals.latestReview(appScope(B.appId), requestB);
    expect(bReview?.approvalRequestId).toBe(requestB);
    expect(bReview?.appId).toBe(B.appId);
    expect(cross.status).toBe(200);
    const bRow = await h.repo.approvals.getRequest(appScope(B.appId), requestB);
    expect(bRow?.resultingResourceId).toBe(B.configId);
    // A's applied review must be untouched.
    const aReview = await h.repo.approvals.latestReview(appScope(ids.appId), requestA);
    expect(aReview?.appId).toBe(ids.appId);
    expect(aReview?.resultingResourceId).toBe(ids.configId);
  });
});
