import type { ErrorResponse } from "@splitch/contracts";
import {
  CONTROL_PANEL_DELEGATION_HEADER,
  issueControlPanelDelegation,
} from "@splitch/control-plane-sdk/control-panel-identity";
import { createRepository } from "@splitch/db";
import type { RateLimiter } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { makeControlPlaneAuthResolver } from "../src/auth-resolver";
import { makePanelSessionAccess } from "../src/panel-session-access";
import { makeFixtureSigner } from "../src/fixture-signer";
import { makeJwksVerifier } from "../src/jwks-verify";
import type { PanelDelegationReplayStore } from "../src/panel-identity-replay";
import { makeSessionStore } from "../src/session-store";
import type { LocalBindings } from "../src/test-fixtures";
import { seedOrgApp, seedOrgMember } from "../src/test-seeds";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

const AUDIENCE = "https://cp.splitch.test";
const NOW_MS = Date.UTC(2026, 6, 18, 22, 0, 0);
const NOW_SECONDS = Math.floor(NOW_MS / 1000);
const DELEGATION_SECRET = "test-control-panel-delegation-secret-1234";
const PRIMARY = {
  orgId: "org_panel_primary",
  orgName: "Panel Primary",
  appId: "app_panel_existing",
  appName: "Existing",
  appKey: "existing",
};
const SECONDARY = {
  orgId: "org_panel_secondary",
  orgName: "Panel Secondary",
  appId: "app_panel_secondary",
  appName: "Secondary",
  appKey: "secondary",
};
const OWNER = "user_panel_owner";
const ADMIN = "user_panel_admin";
const MEMBER = "user_panel_member";
const UNRELATED = "user_panel_unrelated";
const allowLimiter: RateLimiter = () => ({ limited: false });

let app: Hono;
let publicApp: Hono;
let bindings: LocalBindings;

// The Workers pool isolates storage per FILE, not per test (isolatedStorage was
// dropped in the Vitest 4 migration -- workers-sdk#12889), so the fixed-ID seed
// rows go in once here. The Organizations and their memberships are read-only roots: the
// tests that do create an App already use a distinct key each, so their writes
// do not collide across the shared file store.
beforeAll(async () => {
  const seed = await makeLocalBindings();
  await seedOrgApp(seed.d1, PRIMARY);
  await seedOrgApp(seed.d1, SECONDARY);
  await seedOrgMember(seed.d1, { orgId: PRIMARY.orgId, userId: OWNER, role: "owner" });
  await seedOrgMember(seed.d1, { orgId: PRIMARY.orgId, userId: ADMIN, role: "admin" });
  await seedOrgMember(seed.d1, { orgId: PRIMARY.orgId, userId: MEMBER, role: "member" });
});

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
  const repo = createRepository(bindings.d1);
  const appDeps = {
    rateLimiter: allowLimiter,
    repo,
    credentialStore: bindings.credentialKv,
    memberProfileResolver: () => null,
    nowIso: () => new Date(NOW_MS).toISOString(),
  };
  app = createApp({
    ...appDeps,
    authResolver: makeControlPlaneAuthResolver(authDeps, {
      allowPanelDelegation: true,
      panelDelegationSecret: DELEGATION_SECRET,
      panelAccess: makePanelSessionAccess(repo),
      panelDelegationReplay: { consume: async () => true } as PanelDelegationReplayStore,
    }),
  });
  publicApp = createApp({
    ...appDeps,
    authResolver: makeControlPlaneAuthResolver(authDeps),
  });
});

afterEach(async () => bindings.dispose());

describe("Control Panel delegation for apps_create", () => {
  it("rejects panel delegations at the public Control Plane boundary", async () => {
    const response = await createAppRequest(PRIMARY.orgId, OWNER, "public-replay", {}, publicApp);

    expect(response.status).toBe(401);
    expect((await response.json()) satisfies ErrorResponse).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it.each([
    ["owner", OWNER, "a"],
    ["admin", ADMIN, "b"],
  ])("allows an authenticated %s while the Worker performs the live role gate", async (_, userId, suffix) => {
    const response = await createAppRequest(PRIMARY.orgId, userId, `checkout-${suffix}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      app: { organizationId: PRIMARY.orgId, key: `checkout-${suffix}` },
      environments: [{ key: "dev" }, { key: "prod" }],
    });
  });

  it.each([
    ["member", MEMBER, "c"],
    ["unrelated principal", UNRELATED, "d"],
  ])("returns the Worker's typed refusal for a %s", async (_, userId, suffix) => {
    const response = await createAppRequest(PRIMARY.orgId, userId, `denied-${suffix}`);

    expect(response.status).toBe(403);
    expect((await response.json()) satisfies ErrorResponse).toMatchObject({ code: "FORBIDDEN" });
  });

  it("does not let a session for another Organization cross the live D1 boundary", async () => {
    const response = await createAppRequest(SECONDARY.orgId, OWNER, "cross-org");

    expect(response.status).toBe(403);
    expect((await response.json()) satisfies ErrorResponse).toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects expired and malformed downstream identities", async () => {
    const expired = await createAppRequest(PRIMARY.orgId, OWNER, "expired", {}, app, NOW_SECONDS);
    expect(expired.status).toBe(401);

    const malformed = await app.request(`/orgs/${PRIMARY.orgId}/apps`, {
      method: "POST",
      headers: {
        [CONTROL_PANEL_DELEGATION_HEADER]: "not-a-delegation",
        "content-type": "application/json",
      },
      body: JSON.stringify({ organizationId: PRIMARY.orgId, name: "bad", key: "bad" }),
    });
    expect(malformed.status).toBe(401);
  });

  it("never falls back to a panel session when an Authorization header is present but invalid", async () => {
    const response = await createAppRequest(PRIMARY.orgId, OWNER, "no-fallback", {
      authorization: "Bearer invalid",
    });

    expect(response.status).toBe(401);
    expect((await response.json()) satisfies ErrorResponse).toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("Control Panel delegation for Organization membership", () => {
  it("resolves an organization_members_list operation to an Org-bound principal", async () => {
    const request = new Request(`${AUDIENCE}/orgs/${PRIMARY.orgId}/members`);
    const delegation = await issueControlPanelDelegation(
      request,
      { id: "organization_members_list", orgId: PRIMARY.orgId },
      OWNER,
      DELEGATION_SECRET,
      {
        nowSeconds: NOW_SECONDS,
        sessionExpiresAt: NOW_SECONDS + 30,
        nonce: "nonce_members_list_1",
      },
    );

    const response = await app.request(`/orgs/${PRIMARY.orgId}/members`, {
      headers: { [CONTROL_PANEL_DELEGATION_HEADER]: delegation },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ id: OWNER, role: "owner" })]),
    });
  });
});

async function createAppRequest(
  orgId: string,
  actorId: string,
  key: string,
  headers: Record<string, string> = {},
  targetApp = app,
  expiresAt = NOW_SECONDS + 30,
): Promise<Response> {
  const body = JSON.stringify({ name: key, key });
  const request = new Request(`${AUDIENCE}/orgs/${orgId}/apps`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const delegation = await issueControlPanelDelegation(
    request,
    { id: "apps_create", orgId },
    actorId,
    DELEGATION_SECRET,
    {
      nowSeconds: NOW_SECONDS - (expiresAt === NOW_SECONDS ? 30 : 0),
      sessionExpiresAt: expiresAt,
      nonce: `nonce_${key.padEnd(16, "0")}`,
    },
  );
  return targetApp.request(`/orgs/${orgId}/apps`, {
    method: "POST",
    headers: {
      [CONTROL_PANEL_DELEGATION_HEADER]: delegation,
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
}
