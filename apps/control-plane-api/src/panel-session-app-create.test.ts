import type { ErrorResponse } from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import type { RateLimiter } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { makeControlPlaneAuthResolver, PANEL_SESSION_HEADER } from "./auth-resolver";
import { makeFixtureSigner } from "./fixture-signer";
import { makeJwksVerifier } from "./jwks-verify";
import { makeSessionStore } from "./session-store";
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
    authResolver: makeControlPlaneAuthResolver(authDeps, { allowPanelSession: true }),
  });
  publicApp = createApp({
    ...appDeps,
    authResolver: makeControlPlaneAuthResolver(authDeps),
  });
});

afterEach(async () => bindings.dispose());

describe("Control Panel server session transport for apps_create", () => {
  it("rejects panel session handles at the public Control Plane boundary", async () => {
    const tokenHash = await storePanelSession(OWNER, "0");
    const response = await createAppRequest(
      PRIMARY.orgId,
      tokenHash,
      "public-replay",
      {},
      publicApp,
    );

    expect(response.status).toBe(401);
    expect((await response.json()) satisfies ErrorResponse).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it.each([
    ["owner", OWNER, "a"],
    ["admin", ADMIN, "b"],
  ])(
    "allows an authenticated %s while the Worker performs the live role gate",
    async (_, userId, suffix) => {
      const tokenHash = await storePanelSession(userId, suffix);
      const response = await createAppRequest(PRIMARY.orgId, tokenHash, `checkout-${suffix}`);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        app: { organizationId: PRIMARY.orgId, key: `checkout-${suffix}` },
        environments: [{ key: "dev" }, { key: "prod" }],
      });
    },
  );

  it.each([
    ["member", MEMBER, "c"],
    ["unrelated principal", UNRELATED, "d"],
  ])("returns the Worker's typed refusal for a %s", async (_, userId, suffix) => {
    const tokenHash = await storePanelSession(userId, suffix);
    const response = await createAppRequest(PRIMARY.orgId, tokenHash, `denied-${suffix}`);

    expect(response.status).toBe(403);
    expect((await response.json()) satisfies ErrorResponse).toMatchObject({ code: "FORBIDDEN" });
  });

  it("does not let a session for another Organization cross the live D1 boundary", async () => {
    const tokenHash = await storePanelSession(OWNER, "e");
    const response = await createAppRequest(SECONDARY.orgId, tokenHash, "cross-org");

    expect(response.status).toBe(403);
    expect((await response.json()) satisfies ErrorResponse).toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects expired, unknown, and malformed session handles", async () => {
    const expired = await storePanelSession(OWNER, "f", NOW_SECONDS - 1);

    for (const tokenHash of [expired, "0".repeat(64), "not-a-session-handle"]) {
      const response = await createAppRequest(PRIMARY.orgId, tokenHash, "rejected");
      expect(response.status).toBe(401);
      expect((await response.json()) satisfies ErrorResponse).toMatchObject({
        code: "UNAUTHORIZED",
      });
    }
  });

  it("never falls back to a panel session when an Authorization header is present but invalid", async () => {
    const tokenHash = await storePanelSession(OWNER, "1");
    const response = await createAppRequest(PRIMARY.orgId, tokenHash, "no-fallback", {
      authorization: "Bearer invalid",
    });

    expect(response.status).toBe(401);
    expect((await response.json()) satisfies ErrorResponse).toMatchObject({ code: "UNAUTHORIZED" });
  });
});

async function storePanelSession(
  userId: string,
  hashCharacter: string,
  expiresAt = NOW_SECONDS + 3600,
): Promise<string> {
  const tokenHash = hashCharacter.repeat(64);
  await bindings.kv.put(
    `session:${tokenHash}`,
    JSON.stringify({ version: 2, userId, orgs: [], expiresAt }),
  );
  return tokenHash;
}

async function createAppRequest(
  orgId: string,
  tokenHash: string,
  key: string,
  headers: Record<string, string> = {},
  targetApp = app,
): Promise<Response> {
  return targetApp.request(`/orgs/${orgId}/apps`, {
    method: "POST",
    headers: {
      [PANEL_SESSION_HEADER]: tokenHash,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify({ organizationId: orgId, name: key, key }),
  });
}
