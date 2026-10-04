import {
  type PersonalAccessToken,
  PersonalAccessTokenCacheSchema,
  personalAccessTokenCacheKey,
} from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import type { RateLimiter } from "@splitch/worker-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { makeControlPlaneAuthResolver } from "../src/auth-resolver";
import { sha256Hex } from "../src/credential-cache";
import { type FixtureSigner, makeFixtureSigner } from "../src/fixture-signer";
import { makeJwksVerifier } from "../src/jwks-verify";
import { makeSessionStore } from "../src/session-store";
import type { LocalBindings } from "../src/test-fixtures";
import {
  resetOrganizationGraph,
  seedAppMember,
  seedOrgApp,
  seedOrgMember,
} from "../src/test-seeds";
import { makeTokenMembershipAccess } from "../src/token-membership";
import { makePoolBindings } from "./pool-bindings";

/**
 * SPL-683: Personal Access Token management on the public bearer door. The
 * secret leaves the Worker exactly once (create/rotate), every write reaches the
 * SESSION_STORE entry the MCP Worker authenticates against, and grants are
 * validated against live membership.
 */

const AUDIENCE = "https://cp.splitch.test";
const ISSUER = "https://auth.splitch.test";
const NOW_MS = Date.UTC(2026, 9, 3, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;
const ALICE = "user_pat_routes_alice";
const BOB = "user_pat_routes_bob";
const PAY = {
  orgId: "org_pat_routes_pay",
  orgName: "PAT Payments",
  appId: "app_pat_routes_pay",
  appName: "Payments",
  appKey: "pat-payments",
};
const OTHER = {
  orgId: "org_pat_routes_other",
  orgName: "PAT Other",
  appId: "app_pat_routes_other",
  appName: "Other",
  appKey: "pat-other",
};

const allowLimiter: RateLimiter = () => ({ limited: false });

let bindings: LocalBindings;
let signer: FixtureSigner;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  bindings = await makePoolBindings();
  await resetOrganizationGraph(bindings.d1);
  await seedOrgApp(bindings.d1, PAY);
  await seedOrgApp(bindings.d1, OTHER);
  await seedOrgMember(bindings.d1, { orgId: PAY.orgId, userId: ALICE, role: "admin" });
  await seedAppMember(bindings.d1, { appId: PAY.appId, userId: ALICE, role: "admin" });
  await seedOrgMember(bindings.d1, { orgId: OTHER.orgId, userId: BOB, role: "owner" });
  signer = await makeFixtureSigner();
  app = buildApp(bindings.kv);
});

function buildApp(store: KVNamespace): ReturnType<typeof createApp> {
  const repo = createRepository(bindings.d1);
  return createApp({
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
    personalAccessTokenStore: store,
  });
}

afterEach(async () => {
  await bindings.dispose();
});

function jwt(sub: string, authDoor = "device_flow"): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signer.sign({
    sub,
    iss: ISSUER,
    aud: AUDIENCE,
    iat: now,
    exp: now + 3600,
    scopes: [],
    auth_door: authDoor,
  });
}

async function call(
  method: string,
  path: string,
  options: { sub?: string; body?: unknown; authDoor?: string } = {},
): Promise<Response> {
  return app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${await jwt(options.sub ?? ALICE, options.authDoor)}`,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

const readGrant = { target: `app:${PAY.appId}`, role: "admin", access: "read" } as const;

async function create(body: Record<string, unknown>) {
  const response = await call("POST", "/personal-access-tokens", { body });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as { token: PersonalAccessToken; secret: string };
}

async function cacheEntry(secret: string) {
  const raw = await bindings.kv.get(personalAccessTokenCacheKey(await sha256Hex(secret)));
  return raw === null ? null : PersonalAccessTokenCacheSchema.parse(JSON.parse(raw));
}

describe("personal access token routes", () => {
  it("creates a token with a once-only secret and publishes it to the MCP door", async () => {
    const { token, secret } = await create({ name: "sandboxes", grants: [readGrant] });
    expect(secret).toMatch(/^spl_pat_[0-9a-f]{64}$/);
    expect(token).toMatchObject({
      name: "sandboxes",
      grants: [readGrant],
      neverExpires: false,
      status: "active",
      fingerprint: (await sha256Hex(secret)).slice(0, 12),
    });
    const expiresInDays = (Date.parse(token.expiresAt ?? "") - Date.now()) / DAY_MS;
    expect(Math.round(expiresInDays)).toBe(90);
    expect(await cacheEntry(secret)).toMatchObject({
      tokenId: token.id,
      userId: ALICE,
      revoked: false,
    });

    const listed = await call("GET", "/personal-access-tokens");
    const listBody = await listed.text();
    expect(listBody).not.toContain(secret);
    expect(JSON.parse(listBody)).toMatchObject({ items: [{ id: token.id }], readTruncated: false });
    // Another user cannot see the token at all.
    expect(await (await call("GET", "/personal-access-tokens", { sub: BOB })).json()).toMatchObject(
      { items: [] },
    );
  });

  it("creates a never-expiring token only when asked, and flags it", async () => {
    const { token, secret } = await create({
      name: "forever",
      grants: [readGrant],
      expiresAt: null,
    });
    expect(token).toMatchObject({ expiresAt: null, neverExpires: true });
    expect(await cacheEntry(secret)).toMatchObject({ expiresAt: null });
  });

  it("rejects grants outside live membership, above the live role, and past expiries", async () => {
    for (const [body, path] of [
      [{ grants: [{ target: `app:${OTHER.appId}`, role: "member", access: "read" }] }, "target"],
      [{ grants: [{ target: `org:${PAY.orgId}`, role: "owner", access: "read" }] }, "role"],
      [
        { grants: [readGrant], expiresAt: new Date(Date.now() - DAY_MS).toISOString() },
        "expiresAt",
      ],
    ] as const) {
      const response = await call("POST", "/personal-access-tokens", {
        body: { name: "bad", ...body },
      });
      expect(response.status).toBe(400);
      const error = (await response.json()) as { details: { issues: { path: string[] }[] } };
      expect(error.details.issues[0]?.path.at(-1)).toBe(path);
    }
  });

  it("refuses a provisional principal", async () => {
    const response = await call("POST", "/personal-access-tokens", {
      body: { name: "demo", grants: [readGrant] },
      authDoor: "anonymous",
    });
    expect(response.status).toBe(403);
  });

  it("updates grants and expiry without rotating the secret", async () => {
    const { token, secret } = await create({ name: "n", grants: [readGrant] });
    const response = await call("PATCH", `/personal-access-tokens/${token.id}`, {
      body: {
        name: "renamed",
        grants: [{ ...readGrant, role: "member", access: "read-write" }],
        expiresAt: null,
      },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({
      name: "renamed",
      grants: [{ role: "member", access: "read-write" }],
      neverExpires: true,
    });
    expect(await cacheEntry(secret)).toMatchObject({ expiresAt: null, revoked: false });
    expect(
      (
        await call("PATCH", `/personal-access-tokens/${token.id}`, {
          sub: BOB,
          body: { name: "x" },
        })
      ).status,
    ).toBe(404);
  });

  it("rotates: the old secret is tombstoned and the new one published", async () => {
    const { token, secret } = await create({ name: "n", grants: [readGrant] });
    const response = await call("POST", `/personal-access-tokens/${token.id}/rotate`);
    expect(response.status).toBe(200);
    const rotated = (await response.json()) as { token: PersonalAccessToken; secret: string };
    expect(rotated.secret).not.toBe(secret);
    expect(rotated.token.lastRotatedAt).not.toBeNull();
    expect(await cacheEntry(secret)).toMatchObject({ revoked: true });
    expect(await cacheEntry(rotated.secret)).toMatchObject({ tokenId: token.id, revoked: false });
  });

  it("revokes one token, then all remaining tokens, writing tombstones each time", async () => {
    const first = await create({ name: "a", grants: [readGrant] });
    const second = await create({ name: "b", grants: [readGrant] });
    const third = await create({ name: "c", grants: [readGrant] });

    const revoked = await call("POST", `/personal-access-tokens/${first.token.id}/revoke`);
    expect(await revoked.json()).toMatchObject({ status: "revoked" });
    expect(await cacheEntry(first.secret)).toMatchObject({ revoked: true });
    // Retry is safe and re-writes the tombstone.
    expect((await call("POST", `/personal-access-tokens/${first.token.id}/revoke`)).status).toBe(
      200,
    );
    expect((await call("POST", `/personal-access-tokens/${first.token.id}/rotate`)).status).toBe(
      404,
    );

    const all = await call("POST", "/personal-access-tokens/revoke-all");
    expect(await all.json()).toEqual({ revokedCount: 2 });
    expect(await cacheEntry(second.secret)).toMatchObject({ revoked: true });
    expect(await cacheEntry(third.secret)).toMatchObject({ revoked: true });
  });

  it("never accepts a PAT secret as a Control Plane bearer", async () => {
    const { secret } = await create({ name: "n", grants: [readGrant] });
    const response = await app.request("/personal-access-tokens", {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(response.status).toBe(401);
  });

  it("never lets another user rotate, revoke, or update a token", async () => {
    const { token } = await create({ name: "mine", grants: [readGrant] });
    for (const [method, path] of [
      ["POST", `/personal-access-tokens/${token.id}/rotate`],
      ["POST", `/personal-access-tokens/${token.id}/revoke`],
      ["PATCH", `/personal-access-tokens/${token.id}`],
    ] as const) {
      const response = await call(method, path, {
        sub: BOB,
        ...(method === "PATCH" ? { body: { name: "stolen" } } : {}),
      });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    expect(await (await call("GET", "/personal-access-tokens")).json()).toMatchObject({
      items: [{ id: token.id, name: "mine", status: "active" }],
    });
  });

  it("refuses to rotate an expired token until it is extended", async () => {
    const { token } = await create({ name: "short", grants: [readGrant] });
    await createRepository(bindings.d1).personalAccessTokens.update(ALICE, token.id, {
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const refused = await call("POST", `/personal-access-tokens/${token.id}/rotate`);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ message: expect.stringContaining("expired") });
  });

  it("lists active tokens before revoked ones", async () => {
    const older = await create({ name: "older", grants: [readGrant] });
    const newer = await create({ name: "newer", grants: [readGrant] });
    await call("POST", `/personal-access-tokens/${newer.token.id}/revoke`);
    const listed = (await (await call("GET", "/personal-access-tokens")).json()) as {
      items: PersonalAccessToken[];
    };
    expect(listed.items.map((item) => item.id)).toEqual([older.token.id, newer.token.id]);
  });

  it("retires the new row and fails loud when the MCP door cannot be told about it", async () => {
    const failingStore = {
      put: async () => {
        throw new Error("kv unavailable");
      },
    } as unknown as KVNamespace;
    app = buildApp(failingStore);
    const response = await call("POST", "/personal-access-tokens", {
      body: { name: "doomed", grants: [readGrant] },
    });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toMatch(/spl_pat_/);
    const rows = await createRepository(bindings.d1).personalAccessTokens.listActiveForUser(ALICE);
    expect(rows).toEqual([]);
  });
});
