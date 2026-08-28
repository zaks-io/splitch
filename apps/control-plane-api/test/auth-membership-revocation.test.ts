import type { ErrorResponse } from "@splitch/contracts";
import { appScope, createRepository } from "@splitch/db";
import type { RateLimiter } from "@splitch/worker-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { makeControlPlaneAuthResolver } from "../src/auth-resolver";
import { type FixtureSigner, makeFixtureSigner } from "../src/fixture-signer";
import { makeJwksVerifier } from "../src/jwks-verify";
import { appAdminScope } from "../src/scope-binding";
import { makeSessionStore } from "../src/session-store";
import type { LocalBindings } from "../src/test-fixtures";
import {
  resetOrganizationGraph,
  seedAppMember,
  seedEnvironment,
  seedOrgApp,
  seedOrgMember,
} from "../src/test-seeds";
import { makeTokenMembershipAccess } from "../src/token-membership";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

/**
 * SPL-482: a signed App-scoped token is rechecked against live membership on
 * every request. Removal between two requests with the same JWT must fail
 * closed without leaking whether the App exists.
 */

const AUDIENCE = "https://cp.splitch.test";
const NOW_MS = Date.UTC(2026, 7, 27, 12, 0, 0);
const nowSeconds = () => Math.floor(NOW_MS / 1000);

const PAYMENTS = {
  orgId: "org_membership_revocation_pay",
  orgName: "Payments Revocation",
  appId: "app_membership_revocation_pay",
  appName: "Payments",
  appKey: "payments-revocation",
};
const ANALYTICS = {
  orgId: "org_membership_revocation_an",
  orgName: "Analytics Revocation",
  appId: "app_membership_revocation_an",
  appName: "Analytics",
  appKey: "analytics-revocation",
};

const ALICE = "user_membership_revocation_alice";
const BOB = "user_membership_revocation_bob";
const ENV = "env_membership_revocation_pay";

const allowLimiter: RateLimiter = () => ({ limited: false });

interface Harness {
  app: ReturnType<typeof createApp>;
  signer: FixtureSigner;
  bindings: LocalBindings;
  repo: ReturnType<typeof createRepository>;
}

let h: Harness;

beforeEach(async () => {
  const bindings = await makeLocalBindings();
  await resetOrganizationGraph(bindings.d1);
  await seedOrgApp(bindings.d1, PAYMENTS);
  await seedOrgApp(bindings.d1, ANALYTICS);
  await seedEnvironment(bindings.d1, {
    appId: PAYMENTS.appId,
    environmentId: ENV,
    key: "prod",
  });
  await seedOrgMember(bindings.d1, { orgId: PAYMENTS.orgId, userId: ALICE, role: "admin" });
  await seedOrgMember(bindings.d1, { orgId: ANALYTICS.orgId, userId: BOB, role: "member" });
  await seedAppMember(bindings.d1, { appId: PAYMENTS.appId, userId: ALICE, role: "admin" });
  await seedAppMember(bindings.d1, { appId: ANALYTICS.appId, userId: BOB, role: "member" });

  const signer = await makeFixtureSigner();
  const repo = createRepository(bindings.d1);
  const app = createApp({
    authResolver: makeControlPlaneAuthResolver({
      verifier: makeJwksVerifier({
        fetchJwks: async () => signer.jwks,
        controlPlaneAudience: AUDIENCE,
      }),
      sessions: makeSessionStore(bindings.kv),
      membershipAccess: makeTokenMembershipAccess(repo),
      now: () => NOW_MS,
    }),
    rateLimiter: allowLimiter,
    repo,
  });
  h = { app, signer, bindings, repo };
});

afterEach(async () => {
  await h.bindings.dispose();
});

function token(
  sub: string,
  scopes: string[],
  authorization?: "membership-wide-read",
): Promise<string> {
  return h.signer.sign({
    sub,
    iss: "https://auth.splitch.test",
    aud: AUDIENCE,
    iat: nowSeconds(),
    exp: nowSeconds() + 3600,
    scopes,
    auth_door: "id_jag",
    ...(authorization ? { authorization } : {}),
  });
}

function get(path: string, jwt: string): Promise<Response> {
  return h.app.request(path, { headers: { authorization: `Bearer ${jwt}` } });
}

describe("bearer token live membership recheck", () => {
  it("rebuilds wide read authority from D1 and refuses the same JWT after membership removal", async () => {
    const jwt = await token(ALICE, [], "membership-wide-read");

    expect((await get(`/apps/${PAYMENTS.appId}`, jwt)).status).toBe(200);
    expect((await get(`/apps/${ANALYTICS.appId}`, jwt)).status).toBe(403);

    await h.repo.identity.deleteAppMembership(appScope(PAYMENTS.appId), ALICE);

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

    await h.repo.identity.deleteAppMembership(appScope(PAYMENTS.appId), ALICE);

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

    const removed = await h.repo.identity.deleteOrgMembership(PAYMENTS.orgId, ALICE);
    expect(removed).toBe(1);
    expect(await h.repo.identity.getAppMembership(appScope(PAYMENTS.appId), ALICE)).not.toBeNull();

    const refused = await get(`/apps/${PAYMENTS.appId}`, jwt);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as ErrorResponse).code).toBe("FORBIDDEN");
  });

  it("refuses a role-incompatible App claim after demotion, using the same JWT", async () => {
    const jwt = await token(ALICE, [appAdminScope(PAYMENTS.appId)]);
    expect((await get(`/apps/${PAYMENTS.appId}`, jwt)).status).toBe(200);

    await h.repo.identity.updateAppMembership(appScope(PAYMENTS.appId), ALICE, { role: "member" });

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

    await h.repo.identity.deleteAppMembership(appScope(PAYMENTS.appId), ALICE);

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

  it("fails loud with 500 when membershipAccess is unwired and never returns a principal", async () => {
    const jwt = await token(ALICE, [appAdminScope(PAYMENTS.appId)]);
    const app = createApp({
      authResolver: makeControlPlaneAuthResolver({
        verifier: makeJwksVerifier({
          fetchJwks: async () => h.signer.jwks,
          controlPlaneAudience: AUDIENCE,
        }),
        sessions: makeSessionStore(h.bindings.kv),
        now: () => NOW_MS,
        membershipAccess: undefined as unknown as ReturnType<typeof makeTokenMembershipAccess>,
      }),
      rateLimiter: allowLimiter,
      repo: h.repo,
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
          fetchJwks: async () => h.signer.jwks,
          controlPlaneAudience: AUDIENCE,
        }),
        sessions: makeSessionStore(h.bindings.kv),
        now: () => NOW_MS,
        membershipAccess: {
          authorize: async () => {
            throw new Error("d1 membership read failed");
          },
        },
      }),
      rateLimiter: allowLimiter,
      repo: h.repo,
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

    await h.repo.identity.deleteAppMembership(appScope(PAYMENTS.appId), ALICE);

    const missingApp = await get("/apps/app_does_not_exist", jwt);
    const removedMember = await get(`/apps/${PAYMENTS.appId}/envs`, jwt);
    expect(missingApp.status).toBe(403);
    expect(removedMember.status).toBe(403);
    expect(await missingApp.json()).toEqual(await removedMember.json());
  });
});
