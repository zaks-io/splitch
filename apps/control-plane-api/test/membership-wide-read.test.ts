import type { ErrorResponse } from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import type { RateLimiter } from "@splitch/worker-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { makeControlPlaneAuthResolver } from "../src/auth-resolver";
import { type FixtureSigner, makeFixtureSigner } from "../src/fixture-signer";
import { makeJwksVerifier } from "../src/jwks-verify";
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
import { makePoolBindings } from "./pool-bindings";

const AUDIENCE = "https://cp.splitch.test";
const ISSUER = "https://auth.splitch.test";
const NOW_MS = Date.UTC(2026, 7, 28, 12, 0, 0);
const USER = "user_wide_read";
const OWN = {
  orgId: "org_wide_own",
  orgName: "Wide Read Organization",
  appId: "app_wide_own",
  appName: "Wide Read App",
  appKey: "wide-read-app",
};
const FOREIGN = {
  orgId: "org_wide_foreign",
  orgName: "Foreign Organization",
  appId: "app_wide_foreign",
  appName: "Foreign App",
  appKey: "foreign-app",
};
const ENVIRONMENT = "env_wide_own";
const allowLimiter: RateLimiter = () => ({ limited: false });

let bindings: LocalBindings;
let signer: FixtureSigner;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  bindings = await makePoolBindings();
  await resetOrganizationGraph(bindings.d1);
  await seedOrgApp(bindings.d1, OWN);
  await seedOrgApp(bindings.d1, FOREIGN);
  await seedEnvironment(bindings.d1, {
    appId: OWN.appId,
    environmentId: ENVIRONMENT,
    key: "production",
  });
  await seedOrgMember(bindings.d1, { orgId: OWN.orgId, userId: USER, role: "admin" });
  await seedAppMember(bindings.d1, { appId: OWN.appId, userId: USER, role: "admin" });
  signer = await makeFixtureSigner();
  const repo = createRepository(bindings.d1);
  app = createApp({
    authResolver: makeControlPlaneAuthResolver({
      verifier: makeJwksVerifier({
        issuer: ISSUER,
        fetchJwks: async () => signer.jwks,
        controlPlaneAudience: AUDIENCE,
      }),
      sessions: makeSessionStore(bindings.kv),
      membershipAccess: makeTokenMembershipAccess(repo),
      now: () => NOW_MS,
    }),
    rateLimiter: allowLimiter,
    repo,
    memberProfileResolver: ({ userId }) =>
      userId === USER ? { email: "wide@splitch.test" } : null,
  });
});

afterEach(async () => {
  await bindings.dispose();
});

describe("membership-wide Control Plane reads", () => {
  it("lists live Organizations for an id_jag token", async () => {
    const response = await request("/orgs", await wideToken());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [{ id: OWN.orgId }] });
  });

  it("reads its own Organization and App role-gated collections", async () => {
    const token = await wideToken();
    for (const path of [
      `/orgs/${OWN.orgId}`,
      `/orgs/${OWN.orgId}/members`,
      `/orgs/${OWN.orgId}/apps`,
      `/apps/${OWN.appId}/members`,
      `/apps/${OWN.appId}/envs`,
    ]) {
      expect((await request(path, token)).status, path).toBe(200);
    }
  });

  it("refuses a foreign Organization route", async () => {
    const response = await request(`/orgs/${FOREIGN.orgId}`, await wideToken());
    expect(response.status).toBe(403);
    expect(((await response.json()) as ErrorResponse).code).toBe("FORBIDDEN");
  });

  it.each([
    ["wrong issuer", { iss: "https://evil.example" }],
    ["missing issuer", { iss: undefined }],
    ["wrong token type", { typ: "refresh_token" }],
    ["missing token type", { typ: undefined }],
  ])("rejects a token with %s", async (_label, claims) => {
    const response = await request(`/apps/${OWN.appId}`, await wideToken(claims));
    expect(response.status).toBe(401);
    expect(((await response.json()) as ErrorResponse).code).toBe("UNAUTHORIZED");
  });
});

async function wideToken(overrides: Record<string, unknown> = {}): Promise<string> {
  return signer.sign({
    typ: "access_token",
    sub: USER,
    iss: ISSUER,
    aud: AUDIENCE,
    iat: Math.floor(NOW_MS / 1000),
    exp: Math.floor(NOW_MS / 1000) + 3600,
    scopes: [],
    auth_door: "id_jag",
    authorization: "membership-wide-read",
    ...overrides,
  });
}

function request(path: string, token: string): Promise<Response> {
  return app.request(path, { headers: { authorization: `Bearer ${token}` } });
}
