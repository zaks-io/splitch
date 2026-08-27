import type { ErrorResponse } from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import type { RateLimiter } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { makeControlPlaneAuthResolver } from "../src/auth-resolver";
import { type FixtureSigner, makeFixtureSigner } from "../src/fixture-signer";
import { makeJwksVerifier } from "../src/jwks-verify";
import { makeSessionStore } from "../src/session-store";
import type { LocalBindings } from "../src/test-fixtures";
import { seedOrgApp, seedOrgMember } from "../src/test-seeds";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

const AUDIENCE = "https://cp.splitch.test";
const NOW_MS = Date.UTC(2026, 6, 1, 12, 0, 0);
const ORG = {
  orgId: "org_authz_live_7c2b",
  orgName: "Live Authz",
  appId: "app_authz_live_7c2b",
  appName: "Live Authz App",
  appKey: "live-authz",
};
const LIVE_MEMBER = "user_live_member_f91a";
const REMOVED_MEMBER = "user_removed_member_3e8d";
const DOWNGRADED_MEMBER = "user_downgraded_68ac";
const NEW_MEMBER = "user_authz_new_0b5f";

interface Harness {
  app: Hono;
  signer: FixtureSigner;
  bindings: LocalBindings;
}

const allowLimiter: RateLimiter = () => ({ limited: false });
const nowSeconds = () => Math.floor(NOW_MS / 1000);

let h: Harness;

// The Workers pool isolates storage per FILE, not per test (isolatedStorage was
// dropped in the Vitest 4 migration -- workers-sdk#12889), so the fixed-ID seed
// rows go in once here. Every test asserts a 403, so the live membership state
// these tests read is never mutated.
beforeAll(async () => {
  const bindings = await makeLocalBindings();
  await seedOrgApp(bindings.d1, ORG);
  await seedOrgMember(bindings.d1, {
    orgId: ORG.orgId,
    userId: LIVE_MEMBER,
    role: "member",
  });
  await seedOrgMember(bindings.d1, {
    orgId: ORG.orgId,
    userId: DOWNGRADED_MEMBER,
    role: "member",
  });
});

beforeEach(async () => {
  const bindings = await makeLocalBindings();
  const signer = await makeFixtureSigner();
  const verifier = makeJwksVerifier({
    fetchJwks: async () => signer.jwks,
    controlPlaneAudience: AUDIENCE,
  });
  const app = createApp({
    authResolver: makeControlPlaneAuthResolver({
      verifier,
      sessions: makeSessionStore(bindings.kv),
      membershipAccess: { authorize: async () => true },
      now: () => NOW_MS,
    }),
    rateLimiter: allowLimiter,
    repo: createRepository(bindings.d1),
    memberProfileResolver: ({ userId }) =>
      userId === NEW_MEMBER ? { email: "authz-new@example.test" } : null,
  });

  h = { app, signer, bindings };
});

afterEach(async () => h.bindings.dispose());

function token(userId: string, role: "owner" | "admin" | "member"): Promise<string> {
  return h.signer.sign({
    sub: userId,
    iss: "https://auth.splitch.test",
    aud: AUDIENCE,
    iat: nowSeconds(),
    exp: nowSeconds() + 3600,
    scopes: [`org:${ORG.orgId}:${role}`],
  });
}

async function request(path: string, jwt: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${jwt}`);
  headers.set("content-type", "application/json");
  return h.app.request(path, { ...init, headers });
}

async function errorCode(res: Response): Promise<ErrorResponse["code"]> {
  return ((await res.json()) as ErrorResponse).code;
}

describe("control-plane org/member live membership authorization", () => {
  it("rejects an over-granted owner token when D1 membership is only member", async () => {
    const jwt = await token(LIVE_MEMBER, "owner");
    const res = await request(`/orgs/${ORG.orgId}`, jwt, {
      method: "PATCH",
      body: JSON.stringify({ name: "Escalated" }),
    });

    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("FORBIDDEN");
  });

  it("rejects a stale owner token after the actor has no D1 membership", async () => {
    const jwt = await token(REMOVED_MEMBER, "owner");
    const res = await request(`/orgs/${ORG.orgId}/members`, jwt, {
      method: "POST",
      body: JSON.stringify({ userId: NEW_MEMBER, role: "member" }),
    });

    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("FORBIDDEN");
  });

  it("rejects a stale member token when reading Org settings", async () => {
    const jwt = await token(REMOVED_MEMBER, "member");
    const res = await request(`/orgs/${ORG.orgId}`, jwt, { method: "GET" });

    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("FORBIDDEN");
  });

  it("rejects a stale admin token after the actor was downgraded to member", async () => {
    const jwt = await token(DOWNGRADED_MEMBER, "admin");
    const res = await request(`/orgs/${ORG.orgId}/members`, jwt, {
      method: "POST",
      body: JSON.stringify({ userId: NEW_MEMBER, role: "member" }),
    });

    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("FORBIDDEN");
  });
});
