import type { ErrorResponse } from "@splitch/contracts";
import {
  CONTROL_PANEL_IDENTITY_HEADER,
  issueControlPanelIdentity,
  serializeControlPanelIdentity,
} from "@splitch/control-plane-sdk/control-panel-identity";
import { createRepository } from "@splitch/db";
import type { RateLimiter } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { makeControlPlaneAuthResolver } from "./auth-resolver";
import { makeFixtureSigner } from "./fixture-signer";
import { makeJwksVerifier } from "./jwks-verify";
import { makeSessionStore } from "./session-store";
import type { PanelIdentityReplayStore } from "./panel-identity-replay";
import { type LocalBindings, makeLocalBindings, seedOrgApp, seedOrgMember } from "./test-fixtures";

const AUDIENCE = "https://cp.splitch.test";
const NOW_MS = Date.UTC(2026, 6, 18, 22, 0, 0);
const NOW_SECONDS = Math.floor(NOW_MS / 1000);
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

beforeEach(async () => {
  bindings = await makeLocalBindings();
  await seedOrgApp(bindings.d1, PRIMARY);
  await seedOrgApp(bindings.d1, SECONDARY);
  await seedOrgMember(bindings.d1, { orgId: PRIMARY.orgId, userId: OWNER, role: "owner" });
  await seedOrgMember(bindings.d1, { orgId: PRIMARY.orgId, userId: ADMIN, role: "admin" });
  await seedOrgMember(bindings.d1, { orgId: PRIMARY.orgId, userId: MEMBER, role: "member" });

  const signer = await makeFixtureSigner();
  const authDeps = {
    verifier: makeJwksVerifier({
      fetchJwks: async () => signer.jwks,
      controlPlaneAudience: AUDIENCE,
    }),
    sessions: makeSessionStore(bindings.kv),
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
      allowPanelIdentity: true,
      panelIdentityReplay: { consume: async () => true } as PanelIdentityReplayStore,
    }),
  });
  publicApp = createApp({
    ...appDeps,
    authResolver: makeControlPlaneAuthResolver(authDeps),
  });
});

afterEach(async () => bindings.dispose());

describe("Control Panel downstream identity for apps_create", () => {
  it("rejects panel identities at the public Control Plane boundary", async () => {
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
      headers: { [CONTROL_PANEL_IDENTITY_HEADER]: "not-json", "content-type": "application/json" },
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

async function createAppRequest(
  orgId: string,
  actorId: string,
  key: string,
  headers: Record<string, string> = {},
  targetApp = app,
  expiresAt = NOW_SECONDS + 30,
): Promise<Response> {
  const identity = issueControlPanelIdentity({ id: "apps_create", orgId }, actorId, {
    nowSeconds: NOW_SECONDS - (expiresAt === NOW_SECONDS ? 30 : 0),
    sessionExpiresAt: expiresAt,
    nonce: `nonce_${key.padEnd(16, "0")}`,
  });
  return targetApp.request(`/orgs/${orgId}/apps`, {
    method: "POST",
    headers: {
      [CONTROL_PANEL_IDENTITY_HEADER]: serializeControlPanelIdentity(identity),
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify({ organizationId: orgId, name: key, key }),
  });
}
