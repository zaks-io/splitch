import type { ErrorResponse } from "@splitch/contracts";
import {
  CONTROL_PANEL_DELEGATION_HEADER,
  issueControlPanelDelegation,
} from "@splitch/control-plane-sdk/control-panel-identity";
import { createRepository } from "@splitch/db";
import type { RateLimiter } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { makeControlPlaneAuthResolver } from "../src/auth-resolver";
import { makeFixtureSigner } from "../src/fixture-signer";
import { makeJwksVerifier } from "../src/jwks-verify";
import type { PanelDelegationReplayStore } from "../src/panel-identity-replay";
import { makeSessionStore } from "../src/session-store";
import type { LocalBindings } from "../src/test-fixtures";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

/**
 * `organizations_create` over the Control Panel binding (SPL-205).
 *
 * The Panel's only credential to the Control Plane is a signed delegation, and
 * this is the one Organization operation with no `:orgId` to bind against, so
 * its delegation names the operation and nothing else. That makes these tests
 * the security boundary: the claim must not be forgeable into a resource claim,
 * a delegation for a different operation must not redeem here, and the public
 * boundary must not accept a delegation at all.
 *
 * Every case uses its OWN actor and handle. Identical fixtures have masked real
 * isolation bugs in this repo twice, and a slug-collision test in particular is
 * worthless if two cases share a handle by accident.
 */

const AUDIENCE = "https://cp.splitch.test";
const NOW_MS = Date.UTC(2026, 6, 29, 9, 0, 0);
const NOW_SECONDS = Math.floor(NOW_MS / 1000);
const DELEGATION_SECRET = "test-control-panel-delegation-secret-5205";
const allowLimiter: RateLimiter = () => ({ limited: false });

let app: Hono;
let publicApp: Hono;
let bindings: LocalBindings;

beforeEach(async () => {
  bindings = await makeLocalBindings();
  const signer = await makeFixtureSigner();
  const authDeps = {
    verifier: makeJwksVerifier({
      fetchJwks: async () => signer.jwks,
      controlPlaneAudience: AUDIENCE,
    }),
    sessions: makeSessionStore(bindings.kv),
    membershipAccess: { authorize: async () => true },
    now: () => NOW_MS,
  };
  const appDeps = {
    rateLimiter: allowLimiter,
    repo: createRepository(bindings.d1),
    credentialStore: bindings.credentialKv,
    nowIso: () => new Date(NOW_MS).toISOString(),
  };
  app = createApp({
    ...appDeps,
    authResolver: makeControlPlaneAuthResolver(authDeps, {
      allowPanelDelegation: true,
      panelDelegationSecret: DELEGATION_SECRET,
      panelDelegationReplay: { consume: async () => true } as PanelDelegationReplayStore,
    }),
  });
  publicApp = createApp({
    ...appDeps,
    authResolver: makeControlPlaneAuthResolver(authDeps),
  });
});

afterEach(async () => bindings.dispose());

describe("Control Panel delegation for organizations_create", () => {
  it("lets a signed-in User with no memberships create their first Organization", async () => {
    const response = await createOrgRequest({
      actorId: "user_205_newcomer",
      name: "Newcomer Labs",
      slug: "newcomer-labs-205",
      nonce: "nonce_205_newcomer",
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ slug: "newcomer-labs-205", plan: "free" });
  });

  it("makes the creating principal the owner, so the Organization is reachable afterwards", async () => {
    const created = await createOrgRequest({
      actorId: "user_205_owner",
      name: "Owner Check",
      slug: "owner-check-205",
      nonce: "nonce_205_ownercheck",
    });
    expect(created.status).toBe(201);

    const repo = createRepository(bindings.d1);
    const memberships = await repo.identity.listOrgMembershipsForUser("user_205_owner");
    expect(memberships).toEqual([expect.objectContaining({ role: "owner" })]);
    const org = await repo.identity.getOrg(memberships[0]?.orgId ?? "");
    expect(org).toMatchObject({ slug: "owner-check-205" });
  });

  it("refuses a taken handle verbatim and accepts a corrected one", async () => {
    const first = await createOrgRequest({
      actorId: "user_205_first",
      name: "Collision One",
      slug: "collision-205",
      nonce: "nonce_205_collide_a",
    });
    expect(first.status).toBe(201);

    const collided = await createOrgRequest({
      actorId: "user_205_second",
      name: "Collision Two",
      slug: "collision-205",
      nonce: "nonce_205_collide_b",
    });
    expect(collided.status).toBe(409);
    // The message is what the Panel renders, so its wording is contract.
    expect((await collided.json()) satisfies ErrorResponse).toMatchObject({
      code: "SLUG_CONFLICT",
      message: 'URL handle "collision-205" is already taken',
      details: { conflictingSlug: "collision-205", recommendedAction: "CHOOSE_DIFFERENT_SLUG" },
    });

    const corrected = await createOrgRequest({
      actorId: "user_205_second",
      name: "Collision Two",
      slug: "collision-205-two",
      nonce: "nonce_205_collide_c",
    });
    expect(corrected.status).toBe(201);
  });

  it("rejects panel delegations at the public Control Plane boundary", async () => {
    const response = await createOrgRequest(
      {
        actorId: "user_205_public",
        name: "Public Boundary",
        slug: "public-boundary-205",
        nonce: "nonce_205_publicedge",
      },
      publicApp,
    );

    expect(response.status).toBe(401);
    expect((await response.json()) satisfies ErrorResponse).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("never falls back to a delegation when an Authorization header is present", async () => {
    const response = await createOrgRequest({
      actorId: "user_205_fallback",
      name: "No Fallback",
      slug: "no-fallback-205",
      nonce: "nonce_205_nofallback",
      headers: { authorization: "Bearer invalid" },
    });

    expect(response.status).toBe(401);
    expect((await response.json()) satisfies ErrorResponse).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("does not redeem a delegation issued for a different operation", async () => {
    const body = JSON.stringify({ name: "Swapped", slug: "swapped-205" });
    const request = new Request(`${AUDIENCE}/orgs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const delegation = await issueControlPanelDelegation(
      request,
      { id: "apps_create", orgId: "org_205_elsewhere" },
      "user_205_swap",
      DELEGATION_SECRET,
      { nowSeconds: NOW_SECONDS, sessionExpiresAt: NOW_SECONDS + 30, nonce: "nonce_205_swap00" },
    );

    const response = await app.request("/orgs", {
      method: "POST",
      headers: {
        [CONTROL_PANEL_DELEGATION_HEADER]: delegation,
        "content-type": "application/json",
      },
      body,
    });
    expect(response.status).toBe(401);
  });

  it("rejects a delegation whose body digest does not cover the handle being created", async () => {
    const signedBody = JSON.stringify({ name: "Digest", slug: "digest-205-signed" });
    const delegation = await issueControlPanelDelegation(
      new Request(`${AUDIENCE}/orgs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: signedBody,
      }),
      { id: "organizations_create" },
      "user_205_digest",
      DELEGATION_SECRET,
      { nowSeconds: NOW_SECONDS, sessionExpiresAt: NOW_SECONDS + 30, nonce: "nonce_205_digest0" },
    );

    const response = await app.request("/orgs", {
      method: "POST",
      headers: {
        [CONTROL_PANEL_DELEGATION_HEADER]: delegation,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Digest", slug: "digest-205-swapped" }),
    });
    expect(response.status).toBe(401);
  });

  it("rejects an expired delegation", async () => {
    const response = await createOrgRequest({
      actorId: "user_205_expired",
      name: "Expired",
      slug: "expired-205",
      nonce: "nonce_205_expired0",
      nowSeconds: NOW_SECONDS - 60,
      sessionExpiresAt: NOW_SECONDS - 30,
    });

    expect(response.status).toBe(401);
  });
});

interface OrgRequestOptions {
  actorId: string;
  name: string;
  slug: string;
  nonce: string;
  headers?: Record<string, string>;
  nowSeconds?: number;
  sessionExpiresAt?: number;
}

async function createOrgRequest(options: OrgRequestOptions, targetApp = app): Promise<Response> {
  const body = JSON.stringify({ name: options.name, slug: options.slug });
  const request = new Request(`${AUDIENCE}/orgs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const delegation = await issueControlPanelDelegation(
    request,
    { id: "organizations_create" },
    options.actorId,
    DELEGATION_SECRET,
    {
      nowSeconds: options.nowSeconds ?? NOW_SECONDS,
      sessionExpiresAt: options.sessionExpiresAt ?? NOW_SECONDS + 30,
      nonce: options.nonce,
    },
  );
  return targetApp.request("/orgs", {
    method: "POST",
    headers: {
      [CONTROL_PANEL_DELEGATION_HEADER]: delegation,
      "content-type": "application/json",
      ...options.headers,
    },
    body,
  });
}
