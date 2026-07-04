import {
  apiKeyCacheKey,
  clientKeyCacheKey,
  CredentialCacheKVSchema,
  kvEnvelope,
  type ErrorResponse,
} from "@splitch/contracts";
import { appScope, createRepository, envScope } from "@splitch/db";
import type { RateLimiter } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { makeControlPlaneAuthResolver } from "./auth-resolver";
import { sha256Hex } from "./credential-cache";
import { type FixtureSigner, makeFixtureSigner } from "./fixture-signer";
import { makeJwksVerifier } from "./jwks-verify";
import { makeSessionStore } from "./session-store";
import { type LocalBindings, makeLocalBindings, seedOrgApp, seedOrgMember } from "./test-fixtures";

const AUDIENCE = "https://cp.splitch.test";
const NOW_MS = Date.UTC(2026, 6, 2, 12, 0, 0);
const ORG = {
  orgId: "org_app_env_credential_revoke",
  orgName: "App Env Credential Revoke Co",
  appId: "app_existing_credential_revoke",
  appName: "Existing Credential Revoke App",
  appKey: "existing-credential-revoke",
};
const OWNER = "user_app_env_credential_revoke_owner";

const allowLimiter: RateLimiter = () => ({ limited: false });
const cacheEnvelope = kvEnvelope(CredentialCacheKVSchema);
const nowSeconds = () => Math.floor(NOW_MS / 1000);
const nowIso = () => new Date(NOW_MS).toISOString();

interface Harness {
  app: Hono;
  signer: FixtureSigner;
  bindings: LocalBindings;
}

let h: Harness;

beforeEach(async () => {
  const bindings = await makeLocalBindings();
  await seedOrgApp(bindings.d1, ORG);
  await seedOrgMember(bindings.d1, {
    orgId: ORG.orgId,
    userId: OWNER,
    role: "owner",
  });

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
    nowIso,
  });
}

function orgToken(): Promise<string> {
  return h.signer.sign({
    sub: OWNER,
    iss: "https://auth.splitch.test",
    aud: AUDIENCE,
    iat: nowSeconds(),
    exp: nowSeconds() + 3600,
    scopes: [`org:${ORG.orgId}:owner`],
  });
}

function appToken(appId: string, role: "owner" | "admin" = "owner"): Promise<string> {
  return h.signer.sign({
    sub: OWNER,
    iss: "https://auth.splitch.test",
    aud: AUDIENCE,
    iat: nowSeconds(),
    exp: nowSeconds() + 3600,
    scopes: [`app:${appId}:${role}`],
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

async function createDefaultApp(key: string) {
  const res = await request("POST", `/orgs/${ORG.orgId}/apps`, await orgToken(), {
    organizationId: ORG.orgId,
    name: `Credential Revoke ${key}`,
    key,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    app: { id: string };
    environments: Array<{ id: string; key: string }>;
    clientKeys: Array<{ keyId: string; environmentId: string; keyMaterial: string }>;
  };
}

async function createApiKey(appId: string, environmentId: string) {
  const res = await request(
    "POST",
    `/apps/${appId}/envs/${environmentId}/api-keys`,
    await appToken(appId, "admin"),
    { scopes: ["data-plane:evaluate"] },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { credential: { keyId: string }; value: string };
  return { keyId: body.credential.keyId, cacheKey: apiKeyCacheKey(await sha256Hex(body.value)) };
}

async function clientCacheKey(keyMaterial: string): Promise<string> {
  return clientKeyCacheKey(await sha256Hex(keyMaterial));
}

async function readCache(kv: KVNamespace, key: string) {
  const raw = await kv.get(key, "text");
  if (!raw) return null;
  return cacheEnvelope.parse(JSON.parse(raw));
}

async function bodyOf(res: Response): Promise<ErrorResponse> {
  return (await res.json()) as ErrorResponse;
}

function faultingPutKv(base: KVNamespace): KVNamespace {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "put") {
        return async () => {
          throw new Error("KV unavailable");
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("control-plane parent delete credential revocation", () => {
  it("writes revoked KV tombstones before deleting Environment credentials", async () => {
    const created = await createDefaultApp("env-credential-revoke");
    const dev = created.environments.find((env) => env.key === "dev");
    expect(dev).toBeDefined();
    const clientKey = created.clientKeys.find((key) => key.environmentId === dev?.id);
    expect(clientKey).toBeDefined();
    const apiKey = await createApiKey(created.app.id, dev?.id ?? "");

    const res = await request(
      "DELETE",
      `/apps/${created.app.id}/envs/${dev?.id}`,
      await appToken(created.app.id),
    );
    expect(res.status).toBe(200);

    const clientTombstone = await readCache(
      h.bindings.credentialKv,
      await clientCacheKey(clientKey?.keyMaterial ?? ""),
    );
    expect(clientTombstone?.data).toMatchObject({ kind: "client_key", revoked: true });
    expect((await readCache(h.bindings.credentialKv, apiKey.cacheKey))?.data).toMatchObject({
      kind: "api_key",
      revoked: true,
    });

    const repo = createRepository(h.bindings.d1);
    const scope = envScope(created.app.id, dev?.id ?? "");
    expect(await repo.credentials.listClientKeys(scope)).toHaveLength(0);
    expect(await repo.credentials.listApiKeys(scope)).toHaveLength(0);
  });

  it("writes revoked KV tombstones before deleting App credentials", async () => {
    const created = await createDefaultApp("app-credential-revoke");
    const apiKeys = await Promise.all(
      created.environments.map((env) => createApiKey(created.app.id, env.id)),
    );
    const clientKeys = await Promise.all(
      created.clientKeys.map((key) => clientCacheKey(key.keyMaterial)),
    );

    const res = await request("DELETE", `/apps/${created.app.id}`, await appToken(created.app.id));
    expect(res.status).toBe(200);

    for (const key of clientKeys) {
      expect((await readCache(h.bindings.credentialKv, key))?.data).toMatchObject({
        kind: "client_key",
        revoked: true,
      });
    }
    for (const key of apiKeys.map((apiKey) => apiKey.cacheKey)) {
      expect((await readCache(h.bindings.credentialKv, key))?.data).toMatchObject({
        kind: "api_key",
        revoked: true,
      });
    }
  });

  it("fails loud before parent delete when revoked KV tombstone writes fail", async () => {
    const envDelete = await createDefaultApp("env-credential-fault");
    const env = envDelete.environments.find((candidate) => candidate.key === "dev");
    expect(env).toBeDefined();
    const appDelete = await createDefaultApp("app-credential-fault");
    h.app = makeApp(h.bindings, h.signer, faultingPutKv(h.bindings.credentialKv));

    const envRes = await request(
      "DELETE",
      `/apps/${envDelete.app.id}/envs/${env?.id}`,
      await appToken(envDelete.app.id),
    );
    expect(envRes.status).toBe(500);
    expect((await bodyOf(envRes)).code).toBe("INTERNAL_SERVER_ERROR");

    const appRes = await request(
      "DELETE",
      `/apps/${appDelete.app.id}`,
      await appToken(appDelete.app.id),
    );
    expect(appRes.status).toBe(500);
    expect((await bodyOf(appRes)).code).toBe("INTERNAL_SERVER_ERROR");

    const repo = createRepository(h.bindings.d1);
    expect(
      await repo.identity.getEnvironment(appScope(envDelete.app.id), env?.id ?? ""),
    ).toBeTruthy();
    expect(await repo.identity.getApp(appDelete.app.id)).toBeTruthy();
    expect(await repo.identity.listEnvironments(appScope(appDelete.app.id))).toHaveLength(2);
  });
});
