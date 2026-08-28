import { CredentialCacheKVSchema, clientKeyCacheKey, kvEnvelope } from "@splitch/contracts";
import { createRepository, envScope } from "@splitch/db";
import type { RateLimiter } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { makeControlPlaneAuthResolver } from "../src/auth-resolver";
import { sha256Hex } from "../src/credential-cache";
import { type FixtureSigner, makeFixtureSigner } from "../src/fixture-signer";
import { makeJwksVerifier } from "../src/jwks-verify";
import { makeSessionStore } from "../src/session-store";
import type { LocalBindings } from "../src/test-fixtures";
import { seedAppMember, seedEnvironment, seedOrgApp } from "../src/test-seeds";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

const AUDIENCE = "https://cp.splitch.test";
const NOW_MS = Date.UTC(2026, 6, 2, 12, 0, 0);
const APP = {
  orgId: "org_ck_rps_patch",
  orgName: "Client Key RPS Patch Co",
  appId: "app_ck_rps_patch",
  appName: "Client Key RPS Patch App",
  appKey: "ck-rps-patch",
};
const ENV = { environmentId: "env_ck_rps_patch_prod", key: "prod" };
const ADMIN = "user_ck_rps_patch_admin";
const allowLimiter: RateLimiter = () => ({ limited: false });
const cacheEnvelope = kvEnvelope(CredentialCacheKVSchema);

interface Harness {
  app: Hono;
  signer: FixtureSigner;
  bindings: LocalBindings;
}

let h: Harness;

beforeAll(async () => {
  const bindings = await makeLocalBindings();
  await seedOrgApp(bindings.d1, APP);
  await seedAppMember(bindings.d1, { appId: APP.appId, userId: ADMIN, role: "admin" });
  await seedEnvironment(bindings.d1, { appId: APP.appId, ...ENV });
});

beforeEach(async () => {
  const bindings = await makeLocalBindings();
  const signer = await makeFixtureSigner();
  const verifier = makeJwksVerifier({
    fetchJwks: async () => signer.jwks,
    controlPlaneAudience: AUDIENCE,
  });
  h = {
    app: createApp({
      authResolver: makeControlPlaneAuthResolver({
        verifier,
        sessions: makeSessionStore(bindings.kv),
        membershipAccess: { authorize: async () => true },
        now: () => NOW_MS,
      }),
      rateLimiter: allowLimiter,
      repo: createRepository(bindings.d1),
      credentialStore: bindings.credentialKv,
      nowIso: () => new Date(NOW_MS).toISOString(),
    }),
    signer,
    bindings,
  };
});

afterEach(async () => h.bindings.dispose());

describe("control-plane Client Key rateLimitRps PATCH", () => {
  it("rejects zero, negative, fractional, and non-exact overrides before any mutation", async () => {
    const jwt = await token();
    const provisioned = await clientKeyRequest("GET", jwt);
    expect(provisioned.status).toBe(200);
    const { keyMaterial } = (await provisioned.json()) as { keyMaterial: string };
    const before = await persistedRateLimit(keyMaterial);

    for (const rateLimitRps of [0, -1, 1.5, 7, 80]) {
      const rejected = await clientKeyRequest("PATCH", jwt, { rateLimitRps });
      expect(rejected.status).toBe(400);
      await expect(rejected.json()).resolves.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(await persistedRateLimit(keyMaterial)).toEqual(before);
    }
  });

  it("persists an exact 30 rps PATCH to D1 and the Evaluation KV contract", async () => {
    const jwt = await token();
    const provisioned = await clientKeyRequest("GET", jwt);
    const { keyMaterial } = (await provisioned.json()) as { keyMaterial: string };

    const patched = await clientKeyRequest("PATCH", jwt, { rateLimitRps: 30 });
    expect(patched.status).toBe(200);
    await expect(patched.json()).resolves.toMatchObject({ rateLimitRps: 30 });
    expect(await persistedRateLimit(keyMaterial)).toEqual({ d1: 30, kv: 30 });
  });
});

async function token(): Promise<string> {
  return h.signer.sign({
    sub: ADMIN,
    iss: "https://auth.splitch.test",
    aud: AUDIENCE,
    iat: Math.floor(NOW_MS / 1000),
    exp: Math.floor(NOW_MS / 1000) + 3600,
    scopes: [`app:${APP.appId}:admin`],
  });
}

async function clientKeyRequest(
  method: string,
  jwt: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  return h.app.request(`/apps/${APP.appId}/envs/${ENV.environmentId}/client-key`, {
    method,
    headers: {
      authorization: `Bearer ${jwt}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function persistedRateLimit(
  keyMaterial: string,
): Promise<{ d1: number | null; kv: unknown }> {
  const rows = (
    await createRepository(h.bindings.d1).credentials.listClientKeys(
      envScope(APP.appId, ENV.environmentId),
    )
  ).filter((row) => !row.revokedAt);
  const raw = await h.bindings.credentialKv.get(
    clientKeyCacheKey(await sha256Hex(keyMaterial)),
    "text",
  );
  return {
    d1: rows[0]?.rateLimitRps ?? null,
    kv: raw === null ? null : cacheEnvelope.parse(JSON.parse(raw)).data.rateLimitRps,
  };
}
