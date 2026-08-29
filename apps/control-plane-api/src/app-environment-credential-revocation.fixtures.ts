import {
  apiKeyCacheKey,
  CredentialCacheKVSchema,
  clientKeyCacheKey,
  type ErrorResponse,
  kvEnvelope,
} from "@splitch/contracts";
import { createRepository, envScope } from "@splitch/db";
import type { RateLimiter } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { createApp } from "./app";
import { makeControlPlaneAuthResolver } from "./auth-resolver";
import { sha256Hex, writeApiKeyCache } from "./credential-cache";
import { type FixtureSigner, makeFixtureSigner } from "./fixture-signer";
import { makeJwksVerifier } from "./jwks-verify";
import { makeMembershipCacheInvalidator } from "./membership-cache";
import { makeSessionStore } from "./session-store";
import type { EnvironmentExposureStatusCleanup } from "./environment-exposure-status-cleanup";
import type { LocalBindings } from "./test-fixtures";
import { resetOrganizationGraph, seedOrgApp, seedOrgMember } from "./test-seeds";

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
const noOpExposureStatusCleanup: EnvironmentExposureStatusCleanup = {
  delete: async () => undefined,
};
const noOpHoldoverWriteOutboxCleanup = {
  prepare: async () => undefined,
  markD1Deleted: async () => undefined,
  finalize: async () => undefined,
  cancel: async () => undefined,
  delete: async () => undefined,
};

interface Harness {
  app: Hono;
  signer: FixtureSigner;
  bindings: LocalBindings;
}

export let h: Harness;

/**
 * The bindings factory is a parameter so this fixture stays free of any Miniflare
 * import: it must be, to load inside workerd under the Workers pool. The graph is
 * reset first because the pool isolates storage per test FILE, not per test, and
 * these suites re-seed the same fixed IDs.
 */
export async function setup(makeBindings: () => Promise<LocalBindings>): Promise<void> {
  const bindings = await makeBindings();
  await resetOrganizationGraph(bindings.d1);
  await seedOrgApp(bindings.d1, ORG);
  await seedOrgMember(bindings.d1, {
    orgId: ORG.orgId,
    userId: OWNER,
    role: "owner",
  });

  const signer = await makeFixtureSigner();
  h = { app: makeApp(bindings, signer, bindings.credentialKv), signer, bindings };
}

export async function teardown(): Promise<void> {
  await h.bindings.dispose();
}

export function makeApp(
  bindings: LocalBindings,
  signer: FixtureSigner,
  credentialStore: KVNamespace,
) {
  const verifier = makeJwksVerifier({
    issuer: "https://auth.splitch.test",
    fetchJwks: async () => signer.jwks,
    controlPlaneAudience: AUDIENCE,
  });
  return createApp({
    authResolver: makeControlPlaneAuthResolver({
      verifier,
      sessions: makeSessionStore(bindings.kv),
      membershipAccess: {
        authorize: async () => true,
        resolve: async () => {
          throw new Error("credential revocation fixture has no wide membership fixture");
        },
      },
      now: () => NOW_MS,
    }),
    rateLimiter: allowLimiter,
    repo: createRepository(bindings.d1),
    membershipCache: makeMembershipCacheInvalidator(bindings.kv),
    credentialStore,
    exposureStatusCleanup: noOpExposureStatusCleanup,
    holdoverWriteOutboxCleanup: noOpHoldoverWriteOutboxCleanup,
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

export function appToken(appId: string, role: "owner" | "admin" = "owner"): Promise<string> {
  return h.signer.sign({
    sub: OWNER,
    iss: "https://auth.splitch.test",
    aud: AUDIENCE,
    iat: nowSeconds(),
    exp: nowSeconds() + 3600,
    scopes: [`app:${appId}:${role}`],
  });
}

export async function request(
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

export async function createDefaultApp(key: string) {
  const res = await request("POST", `/orgs/${ORG.orgId}/apps`, await orgToken(), {
    name: `Credential Revoke ${key}`,
    key,
  });
  if (res.status !== 200) throw new Error(`failed to create app: ${res.status}`);
  return (await res.json()) as {
    app: { id: string };
    environments: Array<{ id: string; key: string }>;
    clientKeys: Array<{ keyId: string; environmentId: string; keyMaterial: string }>;
  };
}

export async function createApiKey(appId: string, environmentId: string) {
  const res = await request(
    "POST",
    `/apps/${appId}/envs/${environmentId}/api-keys`,
    await appToken(appId, "admin"),
    { scopes: ["data-plane:evaluate"] },
  );
  if (res.status !== 200) throw new Error(`failed to create API Key: ${res.status}`);
  const body = (await res.json()) as { credential: { keyId: string }; value: string };
  return { keyId: body.credential.keyId, cacheKey: apiKeyCacheKey(await sha256Hex(body.value)) };
}

export async function clientCacheKey(keyMaterial: string): Promise<string> {
  return clientKeyCacheKey(await sha256Hex(keyMaterial));
}

export async function readCache(kv: KVNamespace, key: string) {
  const raw = await kv.get(key, "text");
  if (!raw) return null;
  return cacheEnvelope.parse(JSON.parse(raw));
}

export async function bodyOf(res: Response): Promise<ErrorResponse> {
  return (await res.json()) as ErrorResponse;
}

export function faultingPutKv(base: KVNamespace): KVNamespace {
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

export function credentialCreatingOnFirstTombstone(
  base: KVNamespace,
  appId: string,
  environmentId: string,
): KVNamespace {
  let created = false;
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "put") {
        return async (...args: Parameters<KVNamespace["put"]>) => {
          const result = await target.put(...args);
          if (created) return result;
          created = true;
          const row = await createRepository(h.bindings.d1).credentials.apiKeys.insert(
            envScope(appId, environmentId),
            {
              keyId: "ak_created_during_delete",
              appId,
              environmentId,
              keyHash: "api-key-created-during-delete",
              scopes: JSON.stringify(["data-plane:evaluate"]),
              createdAt: nowIso(),
              createdBy: OWNER,
            },
          );
          await writeApiKeyCache({ credentialStore: target }, row, false, ORG.orgId);
          return result;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
