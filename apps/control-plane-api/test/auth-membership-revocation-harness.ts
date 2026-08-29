import { createRepository } from "@splitch/db";
import type { RateLimiter } from "@splitch/worker-runtime";
import { afterEach, beforeEach, vi } from "vitest";
import { createApp } from "../src/app";
import { makeControlPlaneAuthResolver } from "../src/auth-resolver";
import { type FixtureSigner, makeFixtureSigner } from "../src/fixture-signer";
import { makeJwksVerifier } from "../src/jwks-verify";
import { makeMembershipCacheInvalidator } from "../src/membership-cache";
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
 * SPL-482/SPL-532: a signed App-scoped token is checked against the current
 * membership set. Writers invalidate the shared KV entry; Workers KV's roughly
 * one-minute propagation window is pinned explicitly by the suites below.
 */

export const AUDIENCE = "https://cp.splitch.test";
export const NOW_MS = Date.UTC(2026, 7, 27, 12, 0, 0);
export const nowSeconds = () => Math.floor(NOW_MS / 1000);

export const PAYMENTS = {
  orgId: "org_membership_revocation_pay",
  orgName: "Payments Revocation",
  appId: "app_membership_revocation_pay",
  appName: "Payments",
  appKey: "payments-revocation",
};
export const ANALYTICS = {
  orgId: "org_membership_revocation_an",
  orgName: "Analytics Revocation",
  appId: "app_membership_revocation_an",
  appName: "Analytics",
  appKey: "analytics-revocation",
};

export const ALICE = "user_membership_revocation_alice";
export const BOB = "user_membership_revocation_bob";
export const OWNER = "user_membership_revocation_owner";
export const ENV = "env_membership_revocation_pay";

export const allowLimiter: RateLimiter = () => ({ limited: false });

export interface Harness {
  app: ReturnType<typeof createApp>;
  signer: FixtureSigner;
  bindings: LocalBindings;
  repo: ReturnType<typeof createRepository>;
  analysisFetch: ReturnType<typeof vi.fn>;
  evaluationFetch: ReturnType<typeof vi.fn>;
}

let current: Harness;

export function harness(): Harness {
  return current;
}

export function useRevocationHarness(): void {
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
    await seedOrgMember(bindings.d1, { orgId: PAYMENTS.orgId, userId: OWNER, role: "owner" });
    await seedOrgMember(bindings.d1, { orgId: ANALYTICS.orgId, userId: BOB, role: "member" });
    await seedAppMember(bindings.d1, { appId: PAYMENTS.appId, userId: ALICE, role: "admin" });
    await seedAppMember(bindings.d1, { appId: PAYMENTS.appId, userId: OWNER, role: "owner" });
    await seedAppMember(bindings.d1, { appId: ANALYTICS.appId, userId: BOB, role: "member" });

    const signer = await makeFixtureSigner();
    const repo = createRepository(bindings.d1);
    const analysisFetch = vi.fn(async () => Response.json({ delegated: true }));
    const evaluationFetch = vi.fn(async () => Response.json({ delegated: true }));
    const app = createApp({
      authResolver: makeControlPlaneAuthResolver({
        verifier: makeJwksVerifier({
          issuer: "https://auth.splitch.test",
          fetchJwks: async () => signer.jwks,
          controlPlaneAudience: AUDIENCE,
        }),
        sessions: makeSessionStore(bindings.kv),
        membershipAccess: makeTokenMembershipAccess(repo, bindings.kv),
        now: () => NOW_MS,
      }),
      rateLimiter: allowLimiter,
      repo,
      membershipCache: makeMembershipCacheInvalidator(bindings.kv),
      delegationBindings: {
        "analysis-api": { fetch: analysisFetch } as unknown as Fetcher,
        "evaluation-api": { fetch: evaluationFetch } as unknown as Fetcher,
      },
    });
    current = { app, signer, bindings, repo, analysisFetch, evaluationFetch };
  });

  afterEach(async () => {
    await current.bindings.dispose();
  });
}

export function token(
  sub: string,
  scopes: string[],
  authorization?: "membership-wide-read",
): Promise<string> {
  return current.signer.sign({
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

export function get(path: string, jwt: string): Promise<Response> {
  return current.app.request(path, { headers: { authorization: `Bearer ${jwt}` } });
}

export function post(path: string, jwt: string, body: unknown): Promise<Response> {
  return current.app.request(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
