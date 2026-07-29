import type { ErrorResponse, OrganizationResponse } from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import type { RateLimiter } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { makeControlPlaneAuthResolver } from "../src/auth-resolver";
import { type FixtureSigner, makeFixtureSigner } from "../src/fixture-signer";
import { makeJwksVerifier } from "../src/jwks-verify";
import { makeSessionStore } from "../src/session-store";
import type { LocalBindings } from "../src/test-fixtures";
import { resetOrganizationGraph, seedOrgApp, seedOrgMember } from "../src/test-seeds";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

/**
 * `organizations_create` route proofs (SPL-171).
 *
 * The route has no `:orgId`, so the guard's co-scope check never fires and every
 * authorization decision is the handler's. That makes the negative cases the
 * point of this file: a provisional principal must not be able to mint Organizations,
 * and one principal's Org must stay invisible to an unrelated one.
 */

const AUDIENCE = "https://cp.splitch.test";
const NOW_MS = Date.UTC(2026, 6, 1, 12, 0, 0);

/**
 * Two principals with DISTINCT seeds down to the Org, App, and user id. Shared
 * fixture seeds mask isolation bugs: if both sides read the same row, a handler
 * that ignores the actor still looks correct.
 */
const ALICE = {
  userId: "user_alice_2f71c4",
  orgId: "org_alice_2f71c4",
  orgName: "Alice Industries",
  orgSlug: "alice-industries",
  appId: "app_alice_2f71c4",
  appName: "Alice App",
  appKey: "alice-app",
};
const MALLORY = {
  userId: "user_mallory_9d3ea8",
  orgId: "org_mallory_9d3ea8",
  orgName: "Mallory Unrelated",
  orgSlug: "mallory-unrelated",
  appId: "app_mallory_9d3ea8",
  appName: "Mallory App",
  appKey: "mallory-app",
};

interface Harness {
  app: Hono;
  signer: FixtureSigner;
  bindings: LocalBindings;
}

const allowLimiter: RateLimiter = () => ({ limited: false });
const nowSeconds = () => Math.floor(NOW_MS / 1000);

let h: Harness;

beforeEach(async () => {
  const bindings = await makeLocalBindings();
  // The pool isolates storage per test FILE, not per test, and these fixed-ID
  // Organizations are re-seeded each time, so the graph is cleared first.
  await resetOrganizationGraph(bindings.d1);
  for (const actor of [ALICE, MALLORY]) {
    await seedOrgApp(bindings.d1, actor);
    await seedOrgMember(bindings.d1, {
      orgId: actor.orgId,
      userId: actor.userId,
      role: "owner",
    });
  }

  const signer = await makeFixtureSigner();
  const app = createApp({
    authResolver: makeControlPlaneAuthResolver({
      verifier: makeJwksVerifier({
        fetchJwks: async () => signer.jwks,
        controlPlaneAudience: AUDIENCE,
      }),
      sessions: makeSessionStore(bindings.kv),
      now: () => NOW_MS,
    }),
    rateLimiter: allowLimiter,
    repo: createRepository(bindings.d1),
    memberProfileResolver: () => null,
  });

  h = { app, signer, bindings };
});

afterEach(async () => h.bindings.dispose());

interface TokenOptions {
  userId: string;
  scopes: string[];
  authDoor?: "id_jag" | "anonymous" | "device_flow" | "client_credentials";
}

function token(options: TokenOptions): Promise<string> {
  return h.signer.sign({
    sub: options.userId,
    iss: "https://auth.splitch.test",
    aud: AUDIENCE,
    iat: nowSeconds(),
    exp: nowSeconds() + 3600,
    scopes: options.scopes,
    auth_door: options.authDoor ?? "id_jag",
  });
}

async function request(path: string, jwt: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${jwt}`);
  headers.set("content-type", "application/json");
  return h.app.request(path, { ...init, headers });
}

function ownerToken(actor: typeof ALICE): Promise<string> {
  return token({ userId: actor.userId, scopes: [`org:${actor.orgId}:owner`] });
}

describe("organizations_create", () => {
  it("creates a non-provisional Organization and returns 201", async () => {
    const res = await request("/orgs", await ownerToken(ALICE), {
      method: "POST",
      body: JSON.stringify({ name: "Second Venture" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as OrganizationResponse;
    expect(body).toMatchObject({
      name: "Second Venture",
      // Derived from the name: the caller supplied no explicit handle.
      slug: "second-venture",
    });

    // Provisional state is asserted in D1, not on the wire: `isProvisional` and
    // `demoExpiresAt` are reaper bookkeeping that the Organization envelope
    // deliberately whitelists out. A real (non-demo) Org is the DB fact here.
    const row = await h.bindings.d1
      .prepare("SELECT is_provisional, demo_expires_at FROM organizations WHERE id = ?")
      .bind(body.id)
      .first<{ is_provisional: number; demo_expires_at: string | null }>();
    expect(row).toMatchObject({ is_provisional: 0, demo_expires_at: null });
  });

  it("keeps provisional-reaper columns off the wire envelope", async () => {
    const res = await request("/orgs", await ownerToken(ALICE), {
      method: "POST",
      body: JSON.stringify({ name: "Whitelist Check", slug: "whitelist-check" }),
    });

    expect(Object.keys((await res.json()) as OrganizationResponse).sort()).toEqual([
      "createdAt",
      "id",
      "name",
      "plan",
      "slug",
      "updatedAt",
    ]);
  });

  it("makes the creator an owner in the same transaction as the Organization", async () => {
    const res = await request("/orgs", await ownerToken(ALICE), {
      method: "POST",
      body: JSON.stringify({ name: "Owned On Create", slug: "owned-on-create" }),
    });
    const created = (await res.json()) as OrganizationResponse;

    const membership = await h.bindings.d1
      .prepare("SELECT role FROM org_memberships WHERE org_id = ? AND user_id = ?")
      .bind(created.id, ALICE.userId)
      .first<{ role: string }>();

    // An Org with no owner row is unreachable forever, so the membership must
    // exist by the time the response is observable, not on a later write.
    expect(membership?.role).toBe("owner");
  });

  it("lists the new Organization back to its creator", async () => {
    const create = await request("/orgs", await ownerToken(ALICE), {
      method: "POST",
      body: JSON.stringify({ name: "Listed Venture", slug: "listed-venture" }),
    });
    const created = (await create.json()) as OrganizationResponse;

    // `organizations_list` intersects live D1 membership with the token's scopes,
    // so reading a just-created Org needs a token re-minted to carry its scope —
    // the same re-issue a real client performs after create.
    const jwt = await token({
      userId: ALICE.userId,
      scopes: [`org:${ALICE.orgId}:owner`, `org:${created.id}:owner`],
    });
    const list = await request("/orgs", jwt, { method: "GET" });
    const body = (await list.json()) as { items: OrganizationResponse[] };

    expect(list.status).toBe(200);
    expect(body.items.map((org) => org.id)).toContain(created.id);
  });

  it("hides one principal's new Organization from an unrelated principal", async () => {
    const create = await request("/orgs", await ownerToken(ALICE), {
      method: "POST",
      body: JSON.stringify({ name: "Alice Private", slug: "alice-private" }),
    });
    const created = (await create.json()) as OrganizationResponse;

    const mallory = await token({
      userId: MALLORY.userId,
      // Mallory GUESSES the scope. The token asserts it; only live D1 membership
      // can grant it, and Mallory has none for this Org.
      scopes: [`org:${MALLORY.orgId}:owner`, `org:${created.id}:owner`],
    });

    const read = await request(`/orgs/${created.id}`, mallory, { method: "GET" });
    expect(read.status).toBe(403);
    expect(((await read.json()) as ErrorResponse).code).toBe("FORBIDDEN");

    const list = await request("/orgs", mallory, { method: "GET" });
    const body = (await list.json()) as { items: OrganizationResponse[] };
    expect(body.items.map((org) => org.id)).toEqual([MALLORY.orgId]);
  });

  it("rejects a provisional principal and names the claim ceremony", async () => {
    const jwt = await token({
      userId: ALICE.userId,
      scopes: [`org:${ALICE.orgId}:owner`],
      authDoor: "anonymous",
    });
    const res = await request("/orgs", jwt, {
      method: "POST",
      body: JSON.stringify({ name: "Unbounded Organization" }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorResponse;
    expect(body.code).toBe("FORBIDDEN");
    expect(body.message).toContain("/api/auth/claim/start");

    const count = await h.bindings.d1
      .prepare("SELECT COUNT(*) AS n FROM organizations")
      .first<{ n: number }>();
    expect(count?.n).toBe(2);
  });

  it("rejects a token whose auth_door claim is absent, failing closed", async () => {
    // No `auth_door` at all reads as the provisional door, so an unclaimed token
    // cannot dodge the gate by simply omitting the claim.
    const jwt = await h.signer.sign({
      sub: ALICE.userId,
      iss: "https://auth.splitch.test",
      aud: AUDIENCE,
      iat: nowSeconds(),
      exp: nowSeconds() + 3600,
      scopes: [`org:${ALICE.orgId}:owner`],
    });
    const res = await request("/orgs", jwt, {
      method: "POST",
      body: JSON.stringify({ name: "Doorless" }),
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrorResponse).code).toBe("FORBIDDEN");
  });

  it("returns 409 with a recommendedAction on a duplicate slug", async () => {
    const res = await request("/orgs", await ownerToken(ALICE), {
      method: "POST",
      body: JSON.stringify({ name: "Collides", slug: MALLORY.orgSlug }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorResponse;
    expect(body.code).toBe("SLUG_CONFLICT");
    expect(body.details).toMatchObject({
      resourceType: "organization",
      conflictingSlug: MALLORY.orgSlug,
      recommendedAction: "CHOOSE_DIFFERENT_SLUG",
    });
  });

  it("leaves no orphan Organization behind when the slug collides", async () => {
    await request("/orgs", await ownerToken(ALICE), {
      method: "POST",
      body: JSON.stringify({ name: "Collides", slug: MALLORY.orgSlug }),
    });

    // The batch is the transaction boundary: a rolled-back create must not leave
    // a membership row pointing at an Organization that was never committed.
    const memberships = await h.bindings.d1
      .prepare("SELECT COUNT(*) AS n FROM org_memberships WHERE user_id = ?")
      .bind(ALICE.userId)
      .first<{ n: number }>();
    expect(memberships?.n).toBe(1);
  });
});
