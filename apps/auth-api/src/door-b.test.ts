import { createRepository } from "@splitch/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { makeFixtureDeviceFlow } from "./device-flow";
import { makeD1DeviceRefreshSessionStore } from "./device-session-store";
import { makeJtiCache } from "./jti-cache";
import { makeKvRevocationStore } from "./revocation";
import { makePoolBindings, resetPoolKv } from "./test-bindings-pool";
import {
  type DoorBFixtures,
  type LocalBindings,
  makeDoorBDeps,
  makeFixtureKeypair,
} from "./test-fixtures";
import { makeTokenSigner, type TokenSigner } from "./token-exchange";
import { FIXTURE_TURNSTILE_TOKEN } from "./turnstile";
import { makeFixtureWorkOs } from "./workos";

/**
 * Door B REGISTER integration: anonymous register (Turnstile → rate ceiling →
 * provisional Org+App+Environments). The negative/security cases: a missing or
 * invalid Turnstile token writes ZERO rows, and the rate ceiling caps creation.
 * The claim ceremony lives in claim.test.ts. The app boots in-process on the same
 * code the Worker exports.
 */

const ORIGIN = "https://auth.splitch.test";
const ASSERTION_SECRET = "test-assertion-secret";
const ACCESS_SECRET = "test-access-secret";
const CP_AUDIENCE = "https://cp.splitch.test";
const NOW_MS = 1_780_000_000_000;

let local: LocalBindings;
let signer: TokenSigner;

beforeAll(async () => {
  local = await makePoolBindings();
  signer = makeTokenSigner({
    assertionSecret: ASSERTION_SECRET,
    accessSecret: ACCESS_SECRET,
    issuer: ORIGIN,
    controlPlaneAudience: CP_AUDIENCE,
  });
  await makeFixtureKeypair(); // warm subtle crypto
});

afterAll(async () => {
  await local.dispose();
});

/** A fresh schema per test so row-count assertions are not cross-contaminated. */
async function resetDb(): Promise<void> {
  await resetPoolKv(local);
  for (const table of [
    "environments",
    "app_memberships",
    "apps",
    "org_memberships",
    "organizations",
  ]) {
    await local.d1.prepare(`DELETE FROM ${table}`).run();
  }
}

beforeEach(resetDb);

function build(opts?: Parameters<typeof makeDoorBDeps>[2]): {
  app: ReturnType<typeof createApp>;
  doorB: DoorBFixtures;
} {
  const repo = createRepository(local.d1);
  const doorB = makeDoorBDeps(repo, () => NOW_MS, {
    ...opts,
    tokenSigner: signer,
    sessionStore: opts?.sessionStore ?? local.sessionKv,
  });
  const app = createApp({
    repo,
    accessSecret: ACCESS_SECRET,
    issuer: ORIGIN,
    controlPlaneAudience: CP_AUDIENCE,
    now: () => NOW_MS,
    tokenSigner: signer,
    deviceFlow: makeFixtureDeviceFlow(),
    deviceRefreshSessions: makeD1DeviceRefreshSessionStore(repo, {
      cache: local.sessionKv,
      now: () => NOW_MS,
    }),
    sessionStore: local.sessionKv,
    revocations: makeKvRevocationStore(local.sessionKv),
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
  });
  return { app, doorB };
}

async function rowCount(table: string): Promise<number> {
  const row = await local.d1.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

interface RegisterBody {
  identity_assertion: string;
  user_id: string;
  org_id: string;
  app_id: string;
  demo_expires_at: string;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("missing JWT payload");
  const padded = payload
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(payload.length / 4) * 4, "=");
  return JSON.parse(atob(padded)) as Record<string, unknown>;
}

async function registerOk(app: ReturnType<typeof createApp>): Promise<RegisterBody> {
  const res = await app.request("/agent/identity", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ turnstile_token: FIXTURE_TURNSTILE_TOKEN }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as RegisterBody;
}

describe("Door B register: Turnstile-before-write, provisional Org+App+Environments", () => {
  it("a valid fixture Turnstile token creates a provisional Org + App + default Environments", async () => {
    const { app } = build();
    const body = await registerOk(app);

    expect(body.user_id).toMatch(/^user_anon_/);
    expect(body.org_id).toMatch(/^org_/);
    expect(body.app_id).toMatch(/^app_/);
    expect(body.identity_assertion.split(".")).toHaveLength(3);
    // demo window is 24h out (auth-doors.md step 3).
    expect(new Date(body.demo_expires_at).getTime()).toBe(NOW_MS + 24 * 60 * 60 * 1000);

    const org = await local.d1
      .prepare("SELECT is_provisional, demo_expires_at FROM organizations WHERE id = ?")
      .bind(body.org_id)
      .first<{ is_provisional: number; demo_expires_at: string }>();
    expect(org?.is_provisional).toBe(1);
    expect(org?.demo_expires_at).not.toBeNull();

    expect(await rowCount("apps")).toBe(1);
    // Default Environments are per-App (ADR-0027): production + development.
    const envs = await local.d1
      .prepare("SELECT key FROM environments WHERE app_id = ? ORDER BY key")
      .bind(body.app_id)
      .all<{ key: string }>();
    expect(envs.results.map((r) => r.key)).toEqual(["development", "production"]);
    // The owner membership lands on both Org and App.
    expect(await rowCount("org_memberships")).toBe(1);
    expect(await rowCount("app_memberships")).toBe(1);
  });

  it("labels the pre-claim access token with the anonymous auth door", async () => {
    const { app } = build();
    const registration = await registerOk(app);
    const exchange = await app.request("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        identity_assertion: registration.identity_assertion,
      }).toString(),
    });

    expect(exchange.status).toBe(200);
    const body = (await exchange.json()) as { access_token: string };
    expect(decodeJwtPayload(body.access_token)).toMatchObject({
      sub: registration.user_id,
      auth_door: "anonymous",
      demo_expires_at: registration.demo_expires_at,
    });
  });

  it("a MISSING Turnstile token creates ZERO rows (invalid_request, fail-loud)", async () => {
    const { app } = build();
    const res = await app.request("/agent/identity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
    expect(await rowCount("organizations")).toBe(0);
    expect(await rowCount("apps")).toBe(0);
  });

  it("an INVALID Turnstile token creates ZERO rows (access_denied, before any write)", async () => {
    const { app } = build();
    const res = await app.request("/agent/identity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnstile_token: "not-the-fixture-token" }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("access_denied");
    expect(await rowCount("organizations")).toBe(0);
    expect(await rowCount("apps")).toBe(0);
    expect(await rowCount("environments")).toBe(0);
  });

  it("enforces the per-IP rate ceiling (429 too_many_requests, no rows past the cap)", async () => {
    // Cap of 1/IP/hour: the 2nd create from the same IP trips the ceiling. The 2nd
    // request carries a DISTINCT valid Turnstile token (prefix fixture) so it is
    // the ceiling — not Turnstile single-use — that rejects it.
    const { app } = build({ rateLimits: { perIpPerHour: 1, globalPerHour: 1000 } });
    const headers = { "cf-connecting-ip": "203.0.113.7", "content-type": "application/json" };
    const first = await app.request("/agent/identity", {
      method: "POST",
      headers,
      body: JSON.stringify({ turnstile_token: FIXTURE_TURNSTILE_TOKEN }),
    });
    expect(first.status).toBe(200);
    const second = await app.request("/agent/identity", {
      method: "POST",
      headers,
      body: JSON.stringify({ turnstile_token: `${FIXTURE_TURNSTILE_TOKEN}-2` }),
    });
    expect(second.status).toBe(429);
    expect(((await second.json()) as { error: string }).error).toBe("too_many_requests");
    // The ceiling capped creation: exactly one Org exists.
    expect(await rowCount("organizations")).toBe(1);
  });

  it("error bodies use the lowercase OAuth `error` shape, not the uppercase `code` union", async () => {
    const { app } = build();
    const res = await app.request("/agent/identity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnstile_token: "bad" }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("error");
    expect(body).toHaveProperty("error_description");
    expect(body).not.toHaveProperty("code");
  });
});
