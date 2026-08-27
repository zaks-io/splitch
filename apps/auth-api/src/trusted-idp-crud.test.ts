import { createRepository } from "@splitch/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { makeFixtureDeviceFlow } from "./device-flow";
import { makeD1DeviceRefreshSessionStore } from "./device-session-store";
import { makeJtiCache } from "./jti-cache";
import { makeKvRevocationStore } from "./revocation";
import { makePoolBindings } from "./test-bindings-pool";
import { type LocalBindings, makeDoorBDeps, makeFixtureKeypair } from "./test-fixtures";
import { makeTokenSigner, type TokenSigner } from "./token-exchange";
import { makeFixtureWorkOs } from "./workos";

/**
 * Trusted-IdP CRUD is Org-owner only (access-control-matrix.md). A valid Bearer
 * access token authenticates the actor; the CRUD layer then intersects its exact
 * Org-owner scope with the actor's live Org membership role in D1. A caller
 * missing either grant is FORBIDDEN.
 */

const ASSERTION_SECRET = "test-assertion-secret";
const ACCESS_SECRET = "test-access-secret";
const CP_AUDIENCE = "https://cp.splitch.test";
const ORIGIN = "https://auth.splitch.test";
const NOW_MS = 1_780_000_000_000;
const OWNER = "user_owner"; // owner of ORG_A
const MEMBER = "user_member"; // non-owner member of ORG_A
const OWNER_B = "user_owner_b"; // owner of ORG_B
const ORG_A = "org_acme";
const ORG_B = "org_beta";
const NOW_ISO = "2026-06-29T00:00:00.000Z";

let local: LocalBindings;
let signer: TokenSigner;

async function accessTokenFor(userId: string, scopes: string[]): Promise<string> {
  const assertion = await signer.mintIdentityAssertion(
    userId,
    scopes,
    "id_jag",
    Math.floor(NOW_MS / 1000),
  );
  return signer.exchangeForAccessToken(assertion, Math.floor(NOW_MS / 1000));
}

function buildApp() {
  const repo = createRepository(local.d1);
  const doorB = makeDoorBDeps(repo, () => NOW_MS, {
    tokenSigner: signer,
    sessionStore: local.sessionKv,
  });
  return createApp({
    repo,
    accessSecret: ACCESS_SECRET,
    controlPlaneAudience: CP_AUDIENCE,
    now: () => NOW_MS,
    tokenSigner: signer,
    idJag: {
      repo,
      jtiCache: makeJtiCache(local.kv),
      workos: makeFixtureWorkOs(),
      fetchJwks: async () => ({ keys: [] }),
      authApiOrigin: ORIGIN,
      now: () => NOW_MS,
    },
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

async function seedOrg(orgId: string, ownerId: string): Promise<void> {
  await local.d1
    .prepare(
      "INSERT INTO organizations (id, name, slug, plan, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    )
    .bind(orgId, orgId, orgId, "free", NOW_ISO, NOW_ISO)
    .run();
  await local.d1
    .prepare("INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES (?,?,?,?)")
    .bind(orgId, ownerId, "owner", NOW_ISO)
    .run();
}

beforeAll(async () => {
  local = await makePoolBindings();
  signer = makeTokenSigner({
    assertionSecret: ASSERTION_SECRET,
    accessSecret: ACCESS_SECRET,
    issuer: ORIGIN,
    controlPlaneAudience: CP_AUDIENCE,
  });
  await makeFixtureKeypair(); // warm subtle crypto
  await seedOrg(ORG_A, OWNER);
  await seedOrg(ORG_B, OWNER_B);
  await local.d1
    .prepare("INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES (?,?,?,?)")
    .bind(ORG_A, MEMBER, "member", NOW_ISO)
    .run();
  // A splitch-internal GLOBAL seed (org_id NULL): no tenant may list or delete it.
  await local.d1
    .prepare(
      "INSERT INTO trusted_idps (idp_id, org_id, issuer, jwks_uri, client_ids, enabled, created_at) VALUES (?,?,?,?,?,?,?)",
    )
    .bind(
      "idp_seed_anthropic",
      null,
      "https://idp.anthropic.test",
      "https://idp.anthropic.test/jwks",
      JSON.stringify(["cid"]),
      1,
      NOW_ISO,
    )
    .run();
});

afterAll(async () => {
  await local.dispose();
});

type IdpRow = { idpId: string; issuer: string; orgId: string | null };

async function createIdp(
  app: ReturnType<typeof buildApp>,
  orgId: string,
  token: string,
  issuer: string,
): Promise<IdpRow> {
  const res = await app.request(`/orgs/${orgId}/trusted-idps`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks`, client_ids: ["cid"] }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as IdpRow;
}

describe("trusted-idp CRUD: Org owner only", () => {
  it("an owner can create, list, and delete a trusted IdP (org_id stamped)", async () => {
    const app = buildApp();
    const token = await accessTokenFor(OWNER, [`org:${ORG_A}:owner`]);
    const auth = { authorization: `Bearer ${token}` };

    const idp = await createIdp(app, ORG_A, token, "https://idp.openai.test");
    expect(idp.issuer).toBe("https://idp.openai.test");
    expect(idp.orgId).toBe(ORG_A); // stamped with the authz'd org, not client-supplied

    const listed = await app.request(`/orgs/${ORG_A}/trusted-idps`, { headers: auth });
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as unknown[]).length).toBeGreaterThan(0);

    const removed = await app.request(`/orgs/${ORG_A}/trusted-idps/${idp.idpId}`, {
      method: "DELETE",
      headers: auth,
    });
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as { deleted: boolean }).deleted).toBe(true);
  });

  it("a non-owner member is FORBIDDEN", async () => {
    const app = buildApp();
    const token = await accessTokenFor(MEMBER, [`org:${ORG_A}:member`]);
    const res = await app.request(`/orgs/${ORG_A}/trusted-idps`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("FORBIDDEN");
  });

  it("no token is UNAUTHORIZED", async () => {
    const app = buildApp();
    const res = await app.request(`/orgs/${ORG_A}/trusted-idps`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("UNAUTHORIZED");
  });
});

describe("B1: trusted-idp CRUD is tenant-isolated", () => {
  it("list returns only the tenant's OWN rows — not the global seeds, not another tenant's", async () => {
    const app = buildApp();
    const tokenA = await accessTokenFor(OWNER, [`org:${ORG_A}:owner`]);
    const tokenB = await accessTokenFor(OWNER_B, [`org:${ORG_B}:owner`]);

    const idpA = await createIdp(app, ORG_A, tokenA, "https://a-only.test");
    await createIdp(app, ORG_B, tokenB, "https://b-only.test");

    const listA = (await (
      await app.request(`/orgs/${ORG_A}/trusted-idps`, {
        headers: { authorization: `Bearer ${tokenA}` },
      })
    ).json()) as IdpRow[];
    const issuersA = listA.map((r) => r.issuer);
    expect(issuersA).toContain("https://a-only.test");
    expect(issuersA).not.toContain("https://b-only.test"); // not another tenant's
    expect(issuersA).not.toContain("https://idp.anthropic.test"); // not the global seed
    expect(listA.every((r) => r.orgId === ORG_A)).toBe(true);

    await app.request(`/orgs/${ORG_A}/trusted-idps/${idpA.idpId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${tokenA}` },
    });
  });

  it("org_b cannot DELETE a global seed (the Anthropic seed survives) — 404", async () => {
    const app = buildApp();
    const tokenB = await accessTokenFor(OWNER_B, [`org:${ORG_B}:owner`]);
    const res = await app.request(`/orgs/${ORG_B}/trusted-idps/idp_seed_anthropic`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(res.status).toBe(404); // fail-loud no-op, never a lying {deleted:true}
    expect(((await res.json()) as { code: string }).code).toBe("CREDENTIAL_NOT_FOUND");
    // The seed is still present (proves the delete never touched org_id NULL rows).
    const seed = await local.d1
      .prepare("SELECT idp_id FROM trusted_idps WHERE idp_id = ?")
      .bind("idp_seed_anthropic")
      .first();
    expect(seed).not.toBeNull();
  });

  it("org_b cannot DELETE org_a's IdP — 404, row survives", async () => {
    const app = buildApp();
    const tokenA = await accessTokenFor(OWNER, [`org:${ORG_A}:owner`]);
    const tokenB = await accessTokenFor(OWNER_B, [`org:${ORG_B}:owner`]);
    const idpA = await createIdp(app, ORG_A, tokenA, "https://a-target.test");

    const res = await app.request(`/orgs/${ORG_B}/trusted-idps/${idpA.idpId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(res.status).toBe(404);

    const survivor = await local.d1
      .prepare("SELECT idp_id FROM trusted_idps WHERE idp_id = ?")
      .bind(idpA.idpId)
      .first();
    expect(survivor).not.toBeNull();
  });
});

describe("trusted-idp JWKS URL policy", () => {
  it("rejects unsafe JWKS URLs before writing D1", async () => {
    const app = buildApp();
    const token = await accessTokenFor(OWNER, [`org:${ORG_A}:owner`]);
    const before = await local.d1
      .prepare("SELECT COUNT(*) AS n FROM trusted_idps WHERE org_id = ?")
      .bind(ORG_A)
      .first<{ n: number }>();

    for (const jwksUri of [
      "http://idp.example.com/jwks",
      "https://user:pass@idp.example.com/jwks",
      "https://idp.example.com:8443/jwks",
      "https://idp.example.com/jwks?x=1",
      "https://idp.example.com/jwks#frag",
      "https://127.0.0.1/jwks",
      "https://[::1]/jwks",
      "https://169.254.169.254/jwks",
      "https://10.0.0.1/jwks",
      "https://192.168.1.1/jwks",
      "https://localhost/jwks",
    ]) {
      const res = await app.request(`/orgs/${ORG_A}/trusted-idps`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          issuer: `https://unsafe-${jwksUri.length}.test`,
          jwks_uri: jwksUri,
          client_ids: ["cid"],
        }),
      });
      expect(res.status, jwksUri).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("VALIDATION_ERROR");
    }

    const after = await local.d1
      .prepare("SELECT COUNT(*) AS n FROM trusted_idps WHERE org_id = ?")
      .bind(ORG_A)
      .first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });

  it("still persists a valid public HTTPS JWKS URL", async () => {
    const app = buildApp();
    const token = await accessTokenFor(OWNER, [`org:${ORG_A}:owner`]);
    const idp = await createIdp(app, ORG_A, token, "https://idp.allowed.test");
    const row = await local.d1
      .prepare("SELECT jwks_uri AS jwksUri FROM trusted_idps WHERE idp_id = ?")
      .bind(idp.idpId)
      .first<{ jwksUri: string }>();
    expect(row?.jwksUri).toBe("https://idp.allowed.test/jwks");
    await app.request(`/orgs/${ORG_A}/trusted-idps/${idp.idpId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
  });
});

describe("H1: an identity_assertion cannot be replayed as a control-plane Bearer", () => {
  it("rejects an identity_assertion presented as a Bearer (type confusion)", async () => {
    const app = buildApp();
    // The raw assertion, NOT exchanged for an access token.
    const assertion = await signer.mintIdentityAssertion(
      OWNER,
      ["app:x:owner"],
      "id_jag",
      Math.floor(NOW_MS / 1000),
    );
    const res = await app.request(`/orgs/${ORG_A}/trusted-idps`, {
      headers: { authorization: `Bearer ${assertion}` },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("UNAUTHORIZED");
  });

  it("a genuine exchanged access token still works (control)", async () => {
    const app = buildApp();
    const token = await accessTokenFor(OWNER, [`org:${ORG_A}:owner`]);
    const res = await app.request(`/orgs/${ORG_A}/trusted-idps`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });
});
