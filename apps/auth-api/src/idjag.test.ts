import { createRepository } from "@splitch/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { makeFixtureDeviceFlow } from "./device-flow.js";
import { makeD1DeviceRefreshSessionStore } from "./device-session-store.js";
import { makeJtiCache } from "./jti-cache.js";
import { makeKvRevocationStore } from "./revocation.js";
import type { Jwks } from "./jwks.js";
import {
  type FixtureKeypair,
  type LocalBindings,
  makeDoorBDeps,
  makeFixtureKeypair,
  makeLocalBindings,
  signIdJag,
} from "./test-fixtures.js";
import { makeFixtureWorkOs } from "./workos.js";

/**
 * ID-JAG door integration: a fixture ID-JAG -> identity_assertion -> control-plane
 * token (happy path), plus the fail-loud security cases (unknown issuer, disabled
 * IdP, replayed jti, bad signature). The auth-api app boots in-process on the same
 * code the Worker exports; the port-8791 boot is exercised by `wrangler dev`.
 */

const ORIGIN = "https://auth.splitch.test";
const ISSUER = "https://idp.anthropic.test";
const CLIENT_ID = "splitch-control-plane";
const ACCESS_SECRET = "test-access-secret";
const CP_AUDIENCE = "https://cp.splitch.test";
const NOW_MS = 1_780_000_000_000;
const GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";

let local: LocalBindings;
let keys: FixtureKeypair;

// Seed a global issuer; tenant issuer rows are covered by the cross-tenant test.
async function seedIdp(_jwks: Jwks, enabled: boolean): Promise<void> {
  await local.d1
    .prepare("DELETE FROM trusted_idps WHERE issuer = ? AND org_id IS NULL")
    .bind(ISSUER)
    .run();
  await local.d1
    .prepare(
      "INSERT INTO trusted_idps (idp_id, org_id, issuer, jwks_uri, client_ids, enabled, created_at) VALUES (?,?,?,?,?,?,?)",
    )
    .bind(
      "idp_anthropic",
      null,
      ISSUER,
      "https://idp.anthropic.test/jwks",
      JSON.stringify([CLIENT_ID]),
      enabled ? 1 : 0,
      "2026-06-29T00:00:00.000Z",
    )
    .run();
}

function buildApp(jwksOverride?: Jwks) {
  const repo = createRepository(local.d1);
  const doorB = makeDoorBDeps(repo, () => NOW_MS);
  return createApp({
    repo,
    accessSecret: ACCESS_SECRET,
    controlPlaneAudience: CP_AUDIENCE,
    now: () => NOW_MS,
    idJag: {
      repo,
      jtiCache: makeJtiCache(local.kv),
      workos: makeFixtureWorkOs(),
      fetchJwks: async () => jwksOverride ?? keys.jwks,
      authApiOrigin: ORIGIN,
      now: () => NOW_MS,
    },
    tokenSigner: doorB.tokenSigner,
    register: doorB.register,
    claim: doorB.claim,
    deviceFlow: makeFixtureDeviceFlow(),
    deviceRefreshSessions: makeD1DeviceRefreshSessionStore(repo, {
      cache: local.sessionKv,
      now: () => NOW_MS,
    }),
    revocations: makeKvRevocationStore(local.sessionKv),
  });
}

async function errorOf(res: Response): Promise<string> {
  return ((await res.json()) as { error: string }).error;
}

function validClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const nowSec = Math.floor(NOW_MS / 1000);
  return {
    iss: ISSUER,
    aud: CLIENT_ID,
    exp: nowSec + 600,
    auth_time: nowSec - 10,
    email: "agent-user@example.com",
    email_verified: true,
    jti: `jti-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  };
}

beforeAll(async () => {
  local = await makeLocalBindings();
  keys = await makeFixtureKeypair();
  await seedIdp(keys.jwks, true);
});

afterAll(async () => {
  await local.dispose();
});

describe("Door A: ID-JAG happy path", () => {
  it("exchanges a fixture ID-JAG for an identity_assertion then a control-plane token", async () => {
    const app = buildApp();
    const idJag = await signIdJag(keys.privateKey, validClaims());

    const idRes = await app.request("/agent/identity", {
      method: "POST",
      body: JSON.stringify({ id_jag: idJag }),
    });
    expect(idRes.status).toBe(200);
    const idBody = (await idRes.json()) as { identity_assertion: string; user_id: string };
    expect(idBody.user_id).toBe("user_fixture_agent_user_example_com");
    expect(idBody.identity_assertion.split(".")).toHaveLength(3);

    const tokRes = await app.request("/oauth2/token", {
      method: "POST",
      body: JSON.stringify({ grant_type: GRANT, identity_assertion: idBody.identity_assertion }),
    });
    expect(tokRes.status).toBe(200);
    const tokBody = (await tokRes.json()) as { access_token: string; token_type: string };
    expect(tokBody.token_type).toBe("Bearer");
    expect(tokBody.access_token.split(".")).toHaveLength(3);
  });
});

describe("Door A: fail-loud security paths", () => {
  it("rejects an unknown iss with 401 unknown_issuer (never silently trusted)", async () => {
    const app = buildApp();
    const idJag = await signIdJag(keys.privateKey, validClaims({ iss: "https://evil.test" }));
    const res = await app.request("/agent/identity", {
      method: "POST",
      body: JSON.stringify({ id_jag: idJag }),
    });
    expect(res.status).toBe(401);
    expect(await errorOf(res)).toBe("unknown_issuer");
  });

  it("rejects a disabled trusted_idp (not silently skipped)", async () => {
    await seedIdp(keys.jwks, false);
    const app = buildApp();
    const idJag = await signIdJag(keys.privateKey, validClaims());
    const res = await app.request("/agent/identity", {
      method: "POST",
      body: JSON.stringify({ id_jag: idJag }),
    });
    expect(res.status).toBe(401);
    expect(await errorOf(res)).toBe("issuer_disabled");
    await seedIdp(keys.jwks, true);
  });

  it("rejects a replayed jti", async () => {
    const app = buildApp();
    const claims = validClaims({ jti: "fixed-replay-jti" });
    const idJag = await signIdJag(keys.privateKey, claims);
    const first = await app.request("/agent/identity", {
      method: "POST",
      body: JSON.stringify({ id_jag: idJag }),
    });
    expect(first.status).toBe(200);
    const second = await app.request("/agent/identity", {
      method: "POST",
      body: JSON.stringify({ id_jag: idJag }),
    });
    expect(second.status).toBe(401);
    expect(await errorOf(second)).toBe("replayed_jti");
  });

  it("rejects a token signed by the wrong key (signature actually verified)", async () => {
    const other = await makeFixtureKeypair();
    const app = buildApp(); // verifier uses `keys.jwks`
    const idJag = await signIdJag(other.privateKey, validClaims());
    const res = await app.request("/agent/identity", {
      method: "POST",
      body: JSON.stringify({ id_jag: idJag }),
    });
    expect(res.status).toBe(401);
    expect(await errorOf(res)).toBe("invalid_token");
  });

  it("rejects an unverified email", async () => {
    const app = buildApp();
    const idJag = await signIdJag(keys.privateKey, validClaims({ email_verified: false }));
    const res = await app.request("/agent/identity", {
      method: "POST",
      body: JSON.stringify({ id_jag: idJag }),
    });
    expect(res.status).toBe(401);
    expect(await errorOf(res)).toBe("invalid_token");
  });

  it("rejects an expired token", async () => {
    const app = buildApp();
    const idJag = await signIdJag(
      keys.privateKey,
      validClaims({ exp: Math.floor(NOW_MS / 1000) - 1 }),
    );
    const res = await app.request("/agent/identity", {
      method: "POST",
      body: JSON.stringify({ id_jag: idJag }),
    });
    expect(res.status).toBe(401);
    expect(await errorOf(res)).toBe("invalid_token");
  });

  it("rejects a far-future auth_time (H4: forward-skew bound)", async () => {
    const app = buildApp();
    // auth_time well beyond the 60s forward-skew tolerance. Pre-fix this passed
    // freshness (only `now - authTime` was checked); post-fix it is invalid_token.
    const idJag = await signIdJag(
      keys.privateKey,
      validClaims({ auth_time: Math.floor(NOW_MS / 1000) + 3600 }),
    );
    const res = await app.request("/agent/identity", {
      method: "POST",
      body: JSON.stringify({ id_jag: idJag }),
    });
    expect(res.status).toBe(401);
    expect(await errorOf(res)).toBe("invalid_token");
  });

  it("rejects an unsupported grant_type at /oauth2/token", async () => {
    const app = buildApp();
    const res = await app.request("/oauth2/token", {
      method: "POST",
      body: JSON.stringify({ grant_type: "password", identity_assertion: "x.y.z" }),
    });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("unsupported_grant_type");
  });
});

describe("B1: cross-tenant issuer is NOT honored at the ID-JAG door", () => {
  it("a tenant-registered issuer (org_id set) is rejected as unknown_issuer", async () => {
    // org_a registers an attacker-controlled issuer as ITS OWN trusted IdP.
    const attackerIssuer = "https://attacker.evil";
    await local.d1
      .prepare(
        "INSERT INTO trusted_idps (idp_id, org_id, issuer, jwks_uri, client_ids, enabled, created_at) VALUES (?,?,?,?,?,?,?)",
      )
      .bind(
        "idp_attacker",
        "org_a",
        attackerIssuer,
        "https://attacker.evil/jwks",
        JSON.stringify([CLIENT_ID]),
        1,
        "2026-06-29T00:00:00.000Z",
      )
      .run();

    // The attacker signs an ID-JAG asserting a victim in a DIFFERENT tenant.
    const app = buildApp();
    const idJag = await signIdJag(
      keys.privateKey,
      validClaims({ iss: attackerIssuer, email: "victim@bigcorp.com" }),
    );
    const res = await app.request("/agent/identity", {
      method: "POST",
      body: JSON.stringify({ id_jag: idJag }),
    });
    // The door lookup is global-seed-only: a tenant row is never honored here.
    expect(res.status).toBe(401);
    expect(await errorOf(res)).toBe("unknown_issuer");

    await local.d1.prepare("DELETE FROM trusted_idps WHERE idp_id = ?").bind("idp_attacker").run();
  });
});

describe("OAuth error shape is separate from ErrorResponse", () => {
  it("door errors use lowercase `error`, not the uppercase `code` union", async () => {
    const app = buildApp();
    const idJag = await signIdJag(keys.privateKey, validClaims({ iss: "https://evil.test" }));
    const body = (await (
      await app.request("/agent/identity", {
        method: "POST",
        body: JSON.stringify({ id_jag: idJag }),
      })
    ).json()) as Record<string, unknown>;
    expect(body).toHaveProperty("error");
    expect(body).toHaveProperty("error_description");
    expect(body).not.toHaveProperty("code");
    expect(body).not.toHaveProperty("details");
  });
});
