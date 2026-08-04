import { createRepository } from "@splitch/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { makeFixtureDeviceFlow } from "./device-flow";
import { makeD1DeviceRefreshSessionStore } from "./device-session-store";
import { verifyIdJag } from "./idjag-verify";
import { makeJtiCache } from "./jti-cache";
import type { Jwks } from "./jwks";
import { makeKvRevocationStore } from "./revocation";
import {
  type FixtureKeypair,
  type LocalBindings,
  makeDoorBDeps,
  makeFixtureKeypair,
  makeLocalBindings,
  signIdJag,
} from "./test-fixtures";
import { makeFixtureWorkOs } from "./workos";

/**
 * Dormant ID-JAG verifier coverage: a fixture ID-JAG is checked directly at the
 * verifier boundary, preserving the happy path and fail-loud security cases while
 * Door A remains paused at the HTTP route.
 */

const ORIGIN = "https://auth.splitch.test";
const ISSUER = "https://idp.anthropic.test";
const CLIENT_ID = "splitch-control-plane";
const ACCESS_SECRET = "test-access-secret";
const CP_AUDIENCE = "https://cp.splitch.test";
const NOW_MS = 1_780_000_000_000;

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

function buildVerifierDeps(jwksOverride?: Jwks): Parameters<typeof verifyIdJag>[0] {
  const repo = createRepository(local.d1);
  return {
    repo,
    jtiCache: makeJtiCache(local.kv),
    workos: makeFixtureWorkOs(),
    fetchJwks: async () => jwksOverride ?? keys.jwks,
    authApiOrigin: ORIGIN,
    now: () => NOW_MS,
  };
}

function buildApp() {
  const repo = createRepository(local.d1);
  const doorB = makeDoorBDeps(repo, () => NOW_MS, { sessionStore: local.sessionKv });
  return createApp({
    repo,
    accessSecret: ACCESS_SECRET,
    controlPlaneAudience: CP_AUDIENCE,
    now: () => NOW_MS,
    idJag: buildVerifierDeps(),
    tokenSigner: doorB.tokenSigner,
    register: doorB.register,
    claim: doorB.claim,
    deviceFlow: makeFixtureDeviceFlow(),
    deviceRefreshSessions: makeD1DeviceRefreshSessionStore(repo, {
      cache: local.sessionKv,
      now: () => NOW_MS,
    }),
    sessionStore: local.sessionKv,
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

describe("Dormant ID-JAG verifier: happy path", () => {
  it("verifies a fixture ID-JAG before assertion and control-plane token minting", async () => {
    const deps = buildVerifierDeps();
    const idJag = await signIdJag(keys.privateKey, validClaims());

    const verified = await verifyIdJag(deps, idJag);
    expect(verified).toEqual({
      userId: "user_fixture_agent_user_example_com",
      issuer: ISSUER,
    });

    const signer = makeDoorBDeps(deps.repo, () => NOW_MS).tokenSigner;
    const identityAssertion = await signer.mintIdentityAssertion(
      verified.userId,
      [],
      "id_jag",
      Math.floor(NOW_MS / 1000),
    );
    expect(identityAssertion.split(".")).toHaveLength(3);
    const accessToken = await signer.exchangeForAccessToken(
      identityAssertion,
      Math.floor(NOW_MS / 1000),
    );
    expect(accessToken.split(".")).toHaveLength(3);
  });
});

describe("Dormant ID-JAG verifier: fail-loud security paths", () => {
  it("rejects an unknown iss with 401 unknown_issuer (never silently trusted)", async () => {
    const idJag = await signIdJag(keys.privateKey, validClaims({ iss: "https://evil.test" }));
    await expect(verifyIdJag(buildVerifierDeps(), idJag)).rejects.toMatchObject({
      code: "unknown_issuer",
      status: 401,
    });
  });

  it("rejects a disabled trusted_idp (not silently skipped)", async () => {
    await seedIdp(keys.jwks, false);
    const idJag = await signIdJag(keys.privateKey, validClaims());
    await expect(verifyIdJag(buildVerifierDeps(), idJag)).rejects.toMatchObject({
      code: "issuer_disabled",
      status: 401,
    });
    await seedIdp(keys.jwks, true);
  });

  it("rejects a replayed jti", async () => {
    const deps = buildVerifierDeps();
    const claims = validClaims({ jti: "fixed-replay-jti" });
    const idJag = await signIdJag(keys.privateKey, claims);
    await expect(verifyIdJag(deps, idJag)).resolves.toMatchObject({ issuer: ISSUER });
    await expect(verifyIdJag(deps, idJag)).rejects.toMatchObject({
      code: "replayed_jti",
      status: 401,
    });
  });

  it("rejects a token signed by the wrong key (signature actually verified)", async () => {
    const other = await makeFixtureKeypair();
    const idJag = await signIdJag(other.privateKey, validClaims());
    await expect(verifyIdJag(buildVerifierDeps(), idJag)).rejects.toMatchObject({
      code: "invalid_token",
      status: 401,
    });
  });

  it("rejects an unverified email", async () => {
    const idJag = await signIdJag(keys.privateKey, validClaims({ email_verified: false }));
    await expect(verifyIdJag(buildVerifierDeps(), idJag)).rejects.toMatchObject({
      code: "invalid_token",
      status: 401,
    });
  });

  it("rejects a phone-verified token whose email is unverified", async () => {
    const idJag = await signIdJag(
      keys.privateKey,
      validClaims({ email_verified: false, phone_verified: true }),
    );
    await expect(verifyIdJag(buildVerifierDeps(), idJag)).rejects.toMatchObject({
      code: "invalid_token",
      status: 401,
    });
  });

  it("rejects an expired token", async () => {
    const idJag = await signIdJag(
      keys.privateKey,
      validClaims({ exp: Math.floor(NOW_MS / 1000) - 1 }),
    );
    await expect(verifyIdJag(buildVerifierDeps(), idJag)).rejects.toMatchObject({
      code: "invalid_token",
      status: 401,
    });
  });

  it("rejects a far-future auth_time (H4: forward-skew bound)", async () => {
    // auth_time well beyond the 60s forward-skew tolerance. Pre-fix this passed
    // freshness (only `now - authTime` was checked); post-fix it is invalid_token.
    const idJag = await signIdJag(
      keys.privateKey,
      validClaims({ auth_time: Math.floor(NOW_MS / 1000) + 3600 }),
    );
    await expect(verifyIdJag(buildVerifierDeps(), idJag)).rejects.toMatchObject({
      code: "invalid_token",
      status: 401,
    });
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

describe("B1: cross-tenant issuer is NOT honored by the ID-JAG verifier", () => {
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
    const idJag = await signIdJag(
      keys.privateKey,
      validClaims({ iss: attackerIssuer, email: "victim@bigcorp.com" }),
    );
    await expect(verifyIdJag(buildVerifierDeps(), idJag)).rejects.toMatchObject({
      code: "unknown_issuer",
      status: 401,
    });

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
