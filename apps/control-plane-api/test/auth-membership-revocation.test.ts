import type { ErrorResponse } from "@splitch/contracts";
import { appScope } from "@splitch/db";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { makeControlPlaneAuthResolver } from "../src/auth-resolver";
import { makeJwksVerifier } from "../src/jwks-verify";
import { makeMembershipCacheInvalidator } from "../src/membership-cache";
import { appAdminScope } from "../src/scope-binding";
import { makeSessionStore } from "../src/session-store";
import { makeTokenMembershipAccess } from "../src/token-membership";
import {
  ALICE,
  ANALYTICS,
  AUDIENCE,
  allowLimiter,
  BOB,
  get,
  harness,
  NOW_MS,
  OWNER,
  PAYMENTS,
  token,
  useRevocationHarness,
} from "./auth-membership-revocation-harness";

useRevocationHarness();

describe("bearer token live membership recheck", () => {
  it("rebuilds wide read authority from D1 and refuses the same JWT after membership removal", async () => {
    const jwt = await token(ALICE, [], "membership-wide-read");

    expect((await get(`/apps/${PAYMENTS.appId}`, jwt)).status).toBe(200);
    expect((await get(`/apps/${ANALYTICS.appId}`, jwt)).status).toBe(403);

    await harness().repo.identity.deleteAppMembership(appScope(PAYMENTS.appId), ALICE);
    await makeMembershipCacheInvalidator(harness().bindings.kv).invalidate(ALICE);

    const refused = await get(`/apps/${PAYMENTS.appId}`, jwt);
    expect(refused.status).toBe(403);
    expect((await refused.json()) as ErrorResponse).toMatchObject({
      code: "FORBIDDEN",
      message: "credential is not scoped to this app",
    });
  });

  it("keeps an App-scoped token working while membership exists, then refuses the same JWT after App removal", async () => {
    const jwt = await token(ALICE, [appAdminScope(PAYMENTS.appId)]);

    const allowed = await get(`/apps/${PAYMENTS.appId}`, jwt);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ id: PAYMENTS.appId });

    await harness().repo.identity.deleteAppMembership(appScope(PAYMENTS.appId), ALICE);
    await makeMembershipCacheInvalidator(harness().bindings.kv).invalidate(ALICE);

    const refused = await get(`/apps/${PAYMENTS.appId}`, jwt);
    expect(refused.status).toBe(403);
    expect((await refused.json()) as ErrorResponse).toMatchObject({
      code: "FORBIDDEN",
      message: "live membership is required",
      details: {},
    });
  });

  it("invalidates derived App access when the Organization membership is removed", async () => {
    const jwt = await token(ALICE, [appAdminScope(PAYMENTS.appId)]);
    expect((await get(`/apps/${PAYMENTS.appId}`, jwt)).status).toBe(200);

    const removed = await harness().repo.identity.deleteOrgMembership(PAYMENTS.orgId, ALICE);
    expect(removed).toBe(1);
    expect(
      await harness().repo.identity.getAppMembership(appScope(PAYMENTS.appId), ALICE),
    ).not.toBeNull();
    await makeMembershipCacheInvalidator(harness().bindings.kv).invalidate(ALICE);

    const refused = await get(`/apps/${PAYMENTS.appId}`, jwt);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as ErrorResponse).code).toBe("FORBIDDEN");
  });

  it("refuses a role-incompatible App claim after demotion, using the same JWT", async () => {
    const jwt = await token(ALICE, [appAdminScope(PAYMENTS.appId)]);
    expect((await get(`/apps/${PAYMENTS.appId}`, jwt)).status).toBe(200);

    await harness().repo.identity.updateAppMembership(appScope(PAYMENTS.appId), ALICE, {
      role: "member",
    });
    await makeMembershipCacheInvalidator(harness().bindings.kv).invalidate(ALICE);

    const refused = await get(`/apps/${PAYMENTS.appId}`, jwt);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as ErrorResponse).code).toBe("FORBIDDEN");
  });

  it("leaves an unrelated App token and an unscoped service token unchanged after another membership is removed", async () => {
    const aliceJwt = await token(ALICE, [appAdminScope(PAYMENTS.appId)]);
    const bobJwt = await token(BOB, [`app:${ANALYTICS.appId}:member`]);
    const serviceJwt = await token("svc_smoke", []);

    expect((await get(`/apps/${PAYMENTS.appId}`, aliceJwt)).status).toBe(200);
    expect((await get(`/apps/${ANALYTICS.appId}`, bobJwt)).status).toBe(200);

    await harness().repo.identity.deleteAppMembership(appScope(PAYMENTS.appId), ALICE);
    await makeMembershipCacheInvalidator(harness().bindings.kv).invalidate(ALICE);

    expect((await get(`/apps/${PAYMENTS.appId}`, aliceJwt)).status).toBe(403);
    const stillAllowed = await get(`/apps/${ANALYTICS.appId}`, bobJwt);
    expect(stillAllowed.status).toBe(200);
    expect(await stillAllowed.json()).toMatchObject({ id: ANALYTICS.appId });

    // No membership axes → the recheck is skipped. Co-scope still FORBIDs an
    // App read, which is the existing service-credential / unscoped behavior.
    const service = await get(`/apps/${PAYMENTS.appId}`, serviceJwt);
    expect(service.status).toBe(403);
    const serviceBody = (await service.json()) as ErrorResponse;
    expect(serviceBody.code).toBe("FORBIDDEN");
    expect(serviceBody.message).not.toBe("live membership is required");
  });

  it("invalidates a removed member so the next request is refused", async () => {
    const memberJwt = await token(ALICE, [appAdminScope(PAYMENTS.appId)]);
    const ownerJwt = await token(OWNER, [`app:${PAYMENTS.appId}:owner`]);
    expect((await get(`/apps/${PAYMENTS.appId}`, memberJwt)).status).toBe(200);

    const removed = await harness().app.request(`/apps/${PAYMENTS.appId}/members/${ALICE}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${ownerJwt}` },
    });
    expect(removed.status).toBe(200);

    const refused = await get(`/apps/${PAYMENTS.appId}`, memberJwt);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as ErrorResponse).message).toBe("live membership is required");
  });
});

describe("membership cache wiring and not-found contracts", () => {
  it("fails loud with 500 when a membership mutation has no invalidator", async () => {
    const ownerJwt = await token(OWNER, [`app:${PAYMENTS.appId}:owner`]);
    const app = createApp({
      authResolver: makeControlPlaneAuthResolver({
        verifier: makeJwksVerifier({
          issuer: "https://auth.splitch.test",
          fetchJwks: async () => harness().signer.jwks,
          controlPlaneAudience: AUDIENCE,
        }),
        sessions: makeSessionStore(harness().bindings.kv),
        membershipAccess: makeTokenMembershipAccess(harness().repo, harness().bindings.kv, false),
        now: () => NOW_MS,
      }),
      rateLimiter: allowLimiter,
      repo: harness().repo,
    });

    const refused = await app.request(`/apps/${PAYMENTS.appId}/members/${ALICE}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${ownerJwt}` },
    });
    expect(refused.status).toBe(500);
    expect(
      await harness().repo.identity.getAppMembership(appScope(PAYMENTS.appId), ALICE),
    ).not.toBeNull();
  });

  it("refuses App metadata, Environment, and Flag reads after live membership removal despite a warm cache", async () => {
    const jwt = await token(ALICE, [appAdminScope(PAYMENTS.appId)]);
    expect((await get(`/apps/${PAYMENTS.appId}`, jwt)).status).toBe(200);
    expect((await get(`/apps/${PAYMENTS.appId}/envs`, jwt)).status).toBe(200);
    expect((await get(`/apps/${PAYMENTS.appId}/flags`, jwt)).status).toBe(200);

    await harness().repo.identity.deleteAppMembership(appScope(PAYMENTS.appId), ALICE);
    await harness().repo.identity.deleteOrgMembership(PAYMENTS.orgId, ALICE);

    expect((await get(`/apps/${PAYMENTS.appId}`, jwt)).status).toBe(403);
    expect((await get(`/apps/${PAYMENTS.appId}/envs`, jwt)).status).toBe(403);
    expect((await get(`/apps/${PAYMENTS.appId}/flags`, jwt)).status).toBe(403);
  });

  it("fails loud with 500 when membershipAccess is unwired and never returns a principal", async () => {
    const jwt = await token(ALICE, [appAdminScope(PAYMENTS.appId)]);
    const app = createApp({
      authResolver: makeControlPlaneAuthResolver({
        verifier: makeJwksVerifier({
          issuer: "https://auth.splitch.test",
          fetchJwks: async () => harness().signer.jwks,
          controlPlaneAudience: AUDIENCE,
        }),
        sessions: makeSessionStore(harness().bindings.kv),
        now: () => NOW_MS,
        membershipAccess: undefined as unknown as ReturnType<typeof makeTokenMembershipAccess>,
      }),
      rateLimiter: allowLimiter,
      repo: harness().repo,
    });

    const refused = await app.request(`/apps/${PAYMENTS.appId}`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(refused.status).toBe(500);
    const body = (await refused.json()) as ErrorResponse;
    expect(body).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(body).not.toHaveProperty("id");
    expect(JSON.stringify(body)).not.toContain(PAYMENTS.appId);
  });

  it("fails loud with 500 when the D1 membership read throws and never returns a principal", async () => {
    const jwt = await token(ALICE, [appAdminScope(PAYMENTS.appId)]);
    const app = createApp({
      authResolver: makeControlPlaneAuthResolver({
        verifier: makeJwksVerifier({
          issuer: "https://auth.splitch.test",
          fetchJwks: async () => harness().signer.jwks,
          controlPlaneAudience: AUDIENCE,
        }),
        sessions: makeSessionStore(harness().bindings.kv),
        now: () => NOW_MS,
        membershipAccess: {
          authorize: async () => {
            throw new Error("d1 membership read failed");
          },
          resolve: async () => {
            throw new Error("d1 membership read failed");
          },
        },
      }),
      rateLimiter: allowLimiter,
      repo: harness().repo,
    });

    const refused = await app.request(`/apps/${PAYMENTS.appId}`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(refused.status).toBe(500);
    const body = (await refused.json()) as ErrorResponse;
    expect(body).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(body).not.toHaveProperty("id");
    expect(JSON.stringify(body)).not.toContain(PAYMENTS.appId);
  });

  it("refuses a removed member on an Environment list without leaking App existence", async () => {
    const jwt = await token(ALICE, [appAdminScope(PAYMENTS.appId)]);
    expect((await get(`/apps/${PAYMENTS.appId}/envs`, jwt)).status).toBe(200);

    await harness().repo.identity.deleteAppMembership(appScope(PAYMENTS.appId), ALICE);
    await makeMembershipCacheInvalidator(harness().bindings.kv).invalidate(ALICE);

    const missingApp = await get("/apps/app_does_not_exist", jwt);
    const removedMember = await get(`/apps/${PAYMENTS.appId}/envs`, jwt);
    expect(missingApp.status).toBe(403);
    expect(removedMember.status).toBe(403);
    expect(await missingApp.json()).toEqual(await removedMember.json());
  });
});
