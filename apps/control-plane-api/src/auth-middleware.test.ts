import type { ErrorResponse } from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import type { RateLimiter } from "@splitch/worker-runtime";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { controlPlaneRegistrar, createApp } from "./app.js";
import { appAdminScope } from "./scope-binding.js";
import { makeControlPlaneAuthResolver } from "./auth-resolver.js";
import { type FixtureSigner, makeFixtureSigner } from "./fixture-signer.js";
import { makeJwksVerifier } from "./jwks-verify.js";
import { withRequiredScopes, controlPlaneRoute } from "./routes.js";
import { makeSessionStore, revocationKey } from "./session-store.js";
import {
  type LocalBindings,
  makeLocalBindings,
  seedOrgApp,
  seedOrgMember,
} from "./test-fixtures.js";

/**
 * End-to-end auth-middleware proofs against the REAL mounted Worker: the
 * worker-runtime registrar guard chain, the real control-plane-token resolver,
 * and RS256 tokens signed by a fixture key whose public half the verifier checks.
 * We assert the rejection REASON and the held-vs-required detail, not a weaker
 * status-only check.
 *
 * Distinct, realistic per-tenant fixtures (no identical seeds across tenants or
 * roles): a "payments" App where Alice is admin, an "analytics" App where Bob is
 * a member, and an org-level token (Carol) bound to no App.
 */

const AUDIENCE = "https://cp.splitch.test";

const PAYMENTS = {
  orgId: "org_paymentsvc_7f3a",
  orgName: "Payments Service",
  appId: "app_paymentsvc_7f3a",
  appName: "Payments",
  appKey: "payments-prod",
};
const ANALYTICS = {
  orgId: "org_analytics_b8e2",
  orgName: "Analytics Co",
  appId: "app_analytics_b8e2",
  appName: "Analytics",
  appKey: "analytics-prod",
};

const ALICE = "user_alice_2c91"; // admin on the payments App
const BOB = "user_bob_4d17"; // member on the analytics App
const CAROL = "user_carol_9f55"; // org-level token, bound to no App

const NOW_MS = Date.UTC(2026, 5, 29, 12, 0, 0);
const nowSeconds = () => Math.floor(NOW_MS / 1000);

async function bodyOf(res: Response): Promise<ErrorResponse> {
  return (await res.json()) as ErrorResponse;
}

interface Harness {
  app: Hono;
  scopeGatedApp: Hono;
  signer: FixtureSigner;
  bindings: LocalBindings;
}

const allowLimiter: RateLimiter = () => ({ limited: false });

let h: Harness;

beforeEach(async () => {
  const bindings = await makeLocalBindings();
  await seedOrgApp(bindings.d1, PAYMENTS);
  await seedOrgApp(bindings.d1, ANALYTICS);
  await seedOrgMember(bindings.d1, { orgId: PAYMENTS.orgId, userId: CAROL, role: "member" });

  const signer = await makeFixtureSigner();
  const verifier = makeJwksVerifier({
    fetchJwks: async () => signer.jwks,
    controlPlaneAudience: AUDIENCE,
  });
  const deps = {
    authResolver: makeControlPlaneAuthResolver({
      verifier,
      sessions: makeSessionStore(bindings.kv),
      now: () => NOW_MS,
    }),
    rateLimiter: allowLimiter,
    repo: createRepository(bindings.d1),
  };

  const app = createApp(deps);

  // A role-gated App-write mounted through the SAME registrar + resolver with a
  // concrete required scope, to exercise the generic INSUFFICIENT_SCOPES step.
  const scopeGatedApp = new Hono();
  controlPlaneRegistrar(deps).mount(
    scopeGatedApp,
    withRequiredScopes(controlPlaneRoute("apps_update"), [appAdminScope(PAYMENTS.appId)]),
    () => Response.json({ id: PAYMENTS.appId, ok: true }),
  );

  h = { app, scopeGatedApp, signer, bindings };
});

afterEach(async () => {
  await h.bindings.dispose();
});

function token(signer: FixtureSigner, sub: string, scopes: string[]): Promise<string> {
  return signer.sign({
    sub,
    iss: "https://auth.splitch.test",
    aud: AUDIENCE,
    iat: nowSeconds(),
    exp: nowSeconds() + 3600,
    scopes,
  });
}

async function get(app: Hono, path: string, jwt?: string): Promise<Response> {
  return app.request(path, jwt ? { headers: { authorization: `Bearer ${jwt}` } } : undefined);
}

describe("control-plane auth middleware: authorized path", () => {
  it("200s an App read with a valid token bound to that App", async () => {
    const jwt = await token(h.signer, ALICE, [appAdminScope(PAYMENTS.appId)]);
    const res = await get(h.app, `/apps/${PAYMENTS.appId}`, jwt);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: PAYMENTS.appId, organizationId: PAYMENTS.orgId });
  });

  it("200s an Org read with an org-level token", async () => {
    const jwt = await token(h.signer, CAROL, [`org:${PAYMENTS.orgId}:admin`]);
    const res = await get(h.app, `/orgs/${PAYMENTS.orgId}`, jwt);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: PAYMENTS.orgId, name: PAYMENTS.orgName });
  });

  it("200s an Org read for a member-role token (any membership reads, per the matrix)", async () => {
    // The org read gate is membership (co-scope), not owner/admin: a member of
    // the org can read it (access-control-matrix.md step 4, read vs write).
    const jwt = await token(h.signer, CAROL, [`org:${PAYMENTS.orgId}:member`]);
    const res = await get(h.app, `/orgs/${PAYMENTS.orgId}`, jwt);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: PAYMENTS.orgId });
  });
});

describe("control-plane auth middleware: rejections", () => {
  it("401 UNAUTHORIZED when no token is presented", async () => {
    const res = await get(h.app, `/apps/${PAYMENTS.appId}`);
    expect(res.status).toBe(401);
    expect((await bodyOf(res)).code).toBe("UNAUTHORIZED");
  });

  it("401 UNAUTHORIZED for a malformed Authorization header", async () => {
    const res = await h.app.request(`/apps/${PAYMENTS.appId}`, {
      headers: { authorization: "Token not-a-bearer" },
    });
    expect(res.status).toBe(401);
    expect((await bodyOf(res)).code).toBe("UNAUTHORIZED");
  });

  it("401 UNAUTHORIZED for a token signed by an unknown key (bad signature)", async () => {
    const attacker = await makeFixtureSigner();
    const forged = await token(attacker, ALICE, [appAdminScope(PAYMENTS.appId)]);
    const res = await get(h.app, `/apps/${PAYMENTS.appId}`, forged);
    expect(res.status).toBe(401);
    expect((await bodyOf(res)).code).toBe("UNAUTHORIZED");
  });

  it("403 INSUFFICIENT_SCOPES with held-vs-required when the App role is too low", async () => {
    // Alice holds member on the payments App, but the write route requires admin.
    const jwt = await token(h.signer, ALICE, [`app:${PAYMENTS.appId}:member`]);
    const res = await h.scopeGatedApp.request(`/apps/${PAYMENTS.appId}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(res.status).toBe(403);
    const err = await bodyOf(res);
    expect(err.code).toBe("INSUFFICIENT_SCOPES");
    if (err.code === "INSUFFICIENT_SCOPES") {
      expect(err.details.requiredScopes).toEqual([appAdminScope(PAYMENTS.appId)]);
      expect(err.details.heldScopes).toEqual([`app:${PAYMENTS.appId}:member`]);
    }
  });

  it("403 FORBIDDEN when a token bound to App A hits App B (co-scope mismatch)", async () => {
    const jwt = await token(h.signer, BOB, [`app:${ANALYTICS.appId}:member`]);
    const res = await get(h.app, `/apps/${PAYMENTS.appId}`, jwt);
    expect(res.status).toBe(403);
    expect((await bodyOf(res)).code).toBe("FORBIDDEN");
  });

  it("403 FORBIDDEN when an org-level (App-unbound) token hits an App-scoped route", async () => {
    // Carol's token names no App → appId null → the co-scope step FORBIDs the
    // App route BEFORE the repository is reached (no App row is ever queried).
    const jwt = await token(h.signer, CAROL, [`org:${PAYMENTS.orgId}:admin`]);
    const res = await get(h.app, `/apps/${PAYMENTS.appId}`, jwt);
    expect(res.status).toBe(403);
    expect((await bodyOf(res)).code).toBe("FORBIDDEN");
  });

  it("403 FORBIDDEN when a token bound to org A reads org B (cross-org read blocked)", async () => {
    // Carol is admin on the payments org only; she must not read the analytics
    // org by path. The org co-scope step FORBIDs it BEFORE the repository is
    // reached (no Org row is ever queried). Distinct org ids, not identical seeds.
    const jwt = await token(h.signer, CAROL, [`org:${PAYMENTS.orgId}:admin`]);
    const res = await get(h.app, `/orgs/${ANALYTICS.orgId}`, jwt);
    expect(res.status).toBe(403);
    expect((await bodyOf(res)).code).toBe("FORBIDDEN");
  });

  it("403 FORBIDDEN when an App-only token (org-unbound) reads an Org", async () => {
    // Alice's token names an App but no Org → orgId null → the org co-scope step
    // FORBIDs the org read rather than silently allowing an org-unbound token.
    const jwt = await token(h.signer, ALICE, [appAdminScope(PAYMENTS.appId)]);
    const res = await get(h.app, `/orgs/${PAYMENTS.orgId}`, jwt);
    expect(res.status).toBe(403);
    expect((await bodyOf(res)).code).toBe("FORBIDDEN");
  });

  it("403 CREDENTIAL_REVOKED when the session is revoked in KV", async () => {
    await h.bindings.kv.put(revocationKey(ALICE), "1");
    const jwt = await token(h.signer, ALICE, [appAdminScope(PAYMENTS.appId)]);
    const res = await get(h.app, `/apps/${PAYMENTS.appId}`, jwt);
    expect(res.status).toBe(403);
    expect((await bodyOf(res)).code).toBe("CREDENTIAL_REVOKED");
  });
});

describe("control-plane auth middleware: fail-loud KV fault", () => {
  it("500 (not a silent allow) when the session-store KV throws", async () => {
    const faultingKv = {
      get() {
        throw new Error("KV unavailable");
      },
    } as unknown as KVNamespace;
    const verifier = makeJwksVerifier({
      fetchJwks: async () => h.signer.jwks,
      controlPlaneAudience: AUDIENCE,
    });
    const app = createApp({
      authResolver: makeControlPlaneAuthResolver({
        verifier,
        sessions: makeSessionStore(faultingKv),
        now: () => NOW_MS,
      }),
      rateLimiter: allowLimiter,
      repo: createRepository(h.bindings.d1),
    });
    const jwt = await token(h.signer, ALICE, [appAdminScope(PAYMENTS.appId)]);
    const res = await get(app, `/apps/${PAYMENTS.appId}`, jwt);
    expect(res.status).toBe(500);
    expect((await bodyOf(res)).code).toBe("INTERNAL_SERVER_ERROR");
  });
});
