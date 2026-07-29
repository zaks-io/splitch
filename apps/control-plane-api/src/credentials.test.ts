import {
  apiKeyCacheKey,
  CredentialCacheKVSchema,
  clientKeyCacheKey,
  type ErrorResponse,
  kvEnvelope,
} from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import type { RateLimiter } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { makeControlPlaneAuthResolver } from "./auth-resolver";
import { sha256Hex } from "./credential-cache";
import { type FixtureSigner, makeFixtureSigner } from "./fixture-signer";
import { makeJwksVerifier } from "./jwks-verify";
import { makeSessionStore } from "./session-store";
import { type LocalBindings, makeLocalBindings } from "./test-fixtures";
import { seedAppMember, seedEnvironment, seedOrgApp } from "./test-seeds";

const AUDIENCE = "https://cp.splitch.test";
const NOW_MS = Date.UTC(2026, 6, 2, 12, 0, 0);
const NOW_ISO = new Date(NOW_MS).toISOString();
const APP = {
  orgId: "org_credentials_37ad",
  orgName: "Credentials Co",
  appId: "app_credentials_37ad",
  appName: "Credentials App",
  appKey: "credentials",
};
const ENV = { environmentId: "env_prod_37ad", key: "prod" };
const ADMIN = "user_admin_37ad";
const MEMBER = "user_member_37ad";

const allowLimiter: RateLimiter = () => ({ limited: false });
const cacheEnvelope = kvEnvelope(CredentialCacheKVSchema);

interface Harness {
  app: Hono;
  signer: FixtureSigner;
  bindings: LocalBindings;
}

let h: Harness;

beforeEach(async () => {
  const bindings = await makeLocalBindings();
  await seedOrgApp(bindings.d1, APP);
  await seedAppMember(bindings.d1, { appId: APP.appId, userId: ADMIN, role: "admin" });
  await seedAppMember(bindings.d1, { appId: APP.appId, userId: MEMBER, role: "member" });
  await seedEnvironment(bindings.d1, { appId: APP.appId, ...ENV });
  const signer = await makeFixtureSigner();
  h = { app: makeApp(bindings, signer, bindings.credentialKv), signer, bindings };
});

afterEach(async () => h.bindings.dispose());

function makeApp(bindings: LocalBindings, signer: FixtureSigner, credentialStore: KVNamespace) {
  const verifier = makeJwksVerifier({
    fetchJwks: async () => signer.jwks,
    controlPlaneAudience: AUDIENCE,
  });
  return createApp({
    authResolver: makeControlPlaneAuthResolver({
      verifier,
      sessions: makeSessionStore(bindings.kv),
      now: () => NOW_MS,
    }),
    rateLimiter: allowLimiter,
    repo: createRepository(bindings.d1),
    credentialStore,
    nowIso: () => NOW_ISO,
  });
}

function token(userId: string, role: "admin" | "member"): Promise<string> {
  return h.signer.sign({
    sub: userId,
    iss: "https://auth.splitch.test",
    aud: AUDIENCE,
    iat: Math.floor(NOW_MS / 1000),
    exp: Math.floor(NOW_MS / 1000) + 3600,
    scopes: [`app:${APP.appId}:${role}`],
  });
}

async function request(
  method: string,
  path: string,
  jwt: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  return h.app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${jwt}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function credentialPath(suffix: string): string {
  return `/apps/${APP.appId}/envs/${ENV.environmentId}${suffix}`;
}

async function readCache(kv: KVNamespace, key: string) {
  const raw = await kv.get(key, "text");
  if (!raw) return null;
  return cacheEnvelope.parse(JSON.parse(raw));
}

async function bodyOf(res: Response): Promise<ErrorResponse> {
  return (await res.json()) as ErrorResponse;
}

describe("control-plane credential endpoints", () => {
  it("round-trips Client Key and API Key lifecycle with KV write-through", async () => {
    const jwt = await token(ADMIN, "admin");

    const clientKeyRes = await request("GET", credentialPath("/client-key"), jwt);
    expect(clientKeyRes.status).toBe(200);
    const clientKey = (await clientKeyRes.json()) as {
      keyId: string;
      keyMaterial: string;
      originAllowlist: null;
      isOriginOpen: boolean;
    };
    expect(clientKey.isOriginOpen).toBe(true);
    expect(clientKey.originAllowlist).toBeNull();

    const repeated = await request("GET", credentialPath("/client-key"), jwt);
    expect((await repeated.json()) as unknown).toMatchObject({ keyId: clientKey.keyId });

    const clientCache = await readCache(
      h.bindings.credentialKv,
      clientKeyCacheKey(await sha256Hex(clientKey.keyMaterial)),
    );
    expect(clientCache?.data).toMatchObject({
      appId: APP.appId,
      environmentId: ENV.environmentId,
      kind: "client_key",
      originAllowlist: null,
      revoked: false,
    });

    const patched = await request("PATCH", credentialPath("/client-key"), jwt, {
      originAllowlist: ["https://app.example.test"],
      rateLimitRps: 25,
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({
      keyId: clientKey.keyId,
      originAllowlist: ["https://app.example.test"],
      isOriginOpen: false,
      rateLimitRps: 25,
    });
    expect(
      (
        await readCache(
          h.bindings.credentialKv,
          clientKeyCacheKey(await sha256Hex(clientKey.keyMaterial)),
        )
      )?.data,
    ).toMatchObject({
      originAllowlist: ["https://app.example.test"],
      rateLimitRps: 25,
      revoked: false,
    });

    const created = await request("POST", credentialPath("/api-keys"), jwt, {
      scopes: ["data-plane:evaluate", "data-plane:write"],
    });
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as {
      credential: { keyId: string; scopes: string[]; keyHash?: string; keyMaterial?: string };
      value: string;
    };
    expect(createdBody.value).toMatch(/^sk_/);
    expect(createdBody.credential.keyHash).toBeUndefined();
    expect(createdBody.credential.keyMaterial).toBeUndefined();

    const apiCacheKey = apiKeyCacheKey(await sha256Hex(createdBody.value));
    const keyHash = await sha256Hex(createdBody.value);
    expect((await readCache(h.bindings.credentialKv, apiCacheKey))?.data).toMatchObject({
      kind: "api_key",
      revoked: false,
      scopes: ["data-plane:evaluate", "data-plane:write"],
    });

    const listed = await request("GET", credentialPath("/api-keys"), jwt);
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as { items: Array<Record<string, unknown>> };
    expect(listBody.items).toEqual([
      expect.objectContaining({
        keyId: createdBody.credential.keyId,
        scopes: createdBody.credential.scopes,
      }),
    ]);
    expect(JSON.stringify(listBody)).not.toContain(createdBody.value);
    expect(JSON.stringify(listBody)).not.toContain(keyHash);
    expect(JSON.stringify(listBody)).not.toContain("keyHash");

    const listedAgain = await request("GET", credentialPath("/api-keys"), jwt);
    expect(JSON.stringify(await listedAgain.json())).not.toContain(createdBody.value);

    const revoked = await request(
      "POST",
      credentialPath(`/api-keys/${createdBody.credential.keyId}/revoke`),
      jwt,
      {},
    );
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({
      keyId: createdBody.credential.keyId,
      revokedAt: NOW_ISO,
    });
    expect((await readCache(h.bindings.credentialKv, apiCacheKey))?.data.revoked).toBe(true);
  });

  it("fails loud when revoke KV write-through throws", async () => {
    const jwt = await token(ADMIN, "admin");
    const created = await request("POST", credentialPath("/api-keys"), jwt, {
      scopes: ["data-plane:evaluate"],
    });
    const body = (await created.json()) as { credential: { keyId: string } };

    const faultingKv = {
      put: async () => {
        throw new Error("KV unavailable");
      },
    } as unknown as KVNamespace;
    h.app = makeApp(h.bindings, h.signer, faultingKv);

    const res = await request(
      "POST",
      credentialPath(`/api-keys/${body.credential.keyId}/revoke`),
      jwt,
      {},
    );
    expect(res.status).toBe(500);
    expect((await bodyOf(res)).code).toBe("INTERNAL_SERVER_ERROR");
  });

  it("reasserts a revoked API Key tombstone when the KV entry is missing", async () => {
    const jwt = await token(ADMIN, "admin");
    const created = await request("POST", credentialPath("/api-keys"), jwt, {
      scopes: ["data-plane:evaluate"],
    });
    const body = (await created.json()) as { credential: { keyId: string }; value: string };
    const key = apiKeyCacheKey(await sha256Hex(body.value));

    await request("POST", credentialPath(`/api-keys/${body.credential.keyId}/revoke`), jwt, {});
    await h.bindings.credentialKv.delete(key);
    expect(await readCache(h.bindings.credentialKv, key)).toBeNull();

    const repeated = await request(
      "POST",
      credentialPath(`/api-keys/${body.credential.keyId}/revoke`),
      jwt,
      {},
    );
    expect(repeated.status).toBe(200);
    expect((await readCache(h.bindings.credentialKv, key))?.data.revoked).toBe(true);
  });

  it("rejects member-role tokens for credential management", async () => {
    const res = await request("GET", credentialPath("/client-key"), await token(MEMBER, "member"));
    expect(res.status).toBe(403);
    expect((await bodyOf(res)).code).toBe("INSUFFICIENT_SCOPES");
  });
});
