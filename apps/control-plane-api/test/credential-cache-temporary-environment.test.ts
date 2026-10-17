import { env } from "cloudflare:workers";
import {
  apiKeyCacheKey,
  CredentialCacheKVSchema,
  CURRENT_KV_SCHEMA_VERSION,
  clientKeyCacheKey,
  credentialRevocationCacheKey,
  kvEnvelope,
  TERMINAL_CREDENTIAL_REVOCATION_MARKER,
} from "@splitch/contracts";
import { envScope } from "@splitch/db";
import { beforeEach, expect, it } from "vitest";
import { type Harness, ids, NOW, NOW_MS, token } from "../src/config-store-harness-core";
import { sha256Hex, writeClientKeyCache } from "../src/credential-cache";
import { durableCredentialCacheWriterAccess } from "../src/credential-cache-writer-do";
import { makeTestApp } from "../src/test-app-fixture";
import { makePoolHarness } from "./config-store-pool-harness";

let h: Harness;
let expiresAt: string;
const scope = envScope(ids.appId, ids.devEnvironmentId);
const writer = durableCredentialCacheWriterAccess(env.CREDENTIAL_CACHE_WRITER);
const envelope = kvEnvelope(CredentialCacheKVSchema);

beforeEach(async () => {
  h = await makePoolHarness();
  expiresAt = new Date(Date.now() + 3_600_000).toISOString();
});

async function makeTemporary(expiry = expiresAt) {
  await h.d1
    .prepare(
      `UPDATE environments SET expires_at = ?, synced_from_environment_id = ?, synced_at = ? WHERE id = ?`,
    )
    .bind(expiry, ids.environmentId, NOW, ids.devEnvironmentId)
    .run();
}

async function seedKey() {
  return h.repo.credentials.clientKeys.insert(scope, {
    keyId: "ck_expiry_writer",
    appId: ids.appId,
    environmentId: ids.devEnvironmentId,
    keyMaterial: "pk_expiry_writer_fixture",
    createdAt: NOW,
  });
}

async function readCache(key: string) {
  const raw = await env.CREDENTIAL_STORE.get(key);
  if (raw === null) throw new Error("credential cache fixture missing");
  return envelope.parse(JSON.parse(raw)).data;
}

it("Client Key provisioning and rotation and API Key creation carry expiry through the production writer", async () => {
  await makeTemporary();
  const app = makeTestApp({
    repo: h.repo,
    signer: h.signer,
    sessions: env.SESSION_STORE,
    membershipAccess: {
      authorize: async () => true,
      resolve: async () => {
        throw new Error("unexpected wide read");
      },
    },
    now: () => NOW_MS,
    nowIso: () => NOW,
    credentialStore: env.CREDENTIAL_STORE,
    credentialCacheWriter: writer,
  });
  const headers = {
    authorization: `Bearer ${await token(h.signer)}`,
    "content-type": "application/json",
  };
  const base = `/apps/${ids.appId}/envs/${ids.devEnvironmentId}`;
  const provisioned = await app.request(`${base}/client-key`, { headers });
  expect(provisioned.status).toBe(200);
  const client = (await provisioned.json()) as { keyMaterial: string };
  const firstCacheKey = clientKeyCacheKey(await sha256Hex(client.keyMaterial));
  expect(await readCache(firstCacheKey)).toMatchObject({
    credentialSchemaVersion: 3,
    expiresAt,
    revoked: false,
  });
  const rotated = await app.request(`${base}/client-key/revoke`, {
    method: "POST",
    headers,
    body: "{}",
  });
  expect(rotated.status).toBe(200);
  const rotation = (await rotated.json()) as { newKey: { keyMaterial: string } };
  expect(
    await readCache(clientKeyCacheKey(await sha256Hex(rotation.newKey.keyMaterial))),
  ).toMatchObject({ credentialSchemaVersion: 3, expiresAt, revoked: false });
  expect(await env.CREDENTIAL_STORE.get(credentialRevocationCacheKey(firstCacheKey))).toBe(
    TERMINAL_CREDENTIAL_REVOCATION_MARKER,
  );
  const created = await app.request(`${base}/api-keys`, {
    method: "POST",
    headers,
    body: JSON.stringify({ scopes: ["data-plane:evaluate", "data-plane:write"] }),
  });
  expect(created.status).toBe(200);
  const api = (await created.json()) as { value: string };
  expect(await readCache(apiKeyCacheKey(await sha256Hex(api.value)))).toMatchObject({
    kind: "api_key",
    credentialSchemaVersion: 3,
    expiresAt,
    revoked: false,
  });
});

it("derives v3 expiry from D1 even when its caller supplies v2", async () => {
  await makeTemporary();
  const row = await seedKey();
  await writeClientKeyCache(
    { repo: h.repo, credentialCacheWriter: writer },
    row,
    false,
    ids.orgId,
    true,
  );
  expect(await readCache(clientKeyCacheKey(await sha256Hex(row.keyMaterial)))).toMatchObject({
    credentialSchemaVersion: 3,
    expiresAt,
  });
});

it("keeps permanent credentials v2 even when the caller supplies a v3 expiry", async () => {
  const row = await seedKey();
  const key = clientKeyCacheKey(await sha256Hex(row.keyMaterial));
  await env.CREDENTIAL_CACHE_WRITER.getByName(key).put({
    key,
    credential: { kind: "client_key", keyId: row.keyId },
    value: JSON.stringify({
      schemaVersion: CURRENT_KV_SCHEMA_VERSION,
      data: {
        appId: ids.appId,
        environmentId: ids.devEnvironmentId,
        organizationId: ids.orgId,
        kind: "client_key",
        credentialSchemaVersion: 3,
        expiresAt,
        scopes: ["data-plane:evaluate"],
        originAllowlist: null,
        rateLimitRps: null,
        revoked: false,
        cachedAt: NOW,
      },
    }),
  });
  const cache = await readCache(key);
  expect(cache.credentialSchemaVersion).toBe(2);
  expect(cache).not.toHaveProperty("expiresAt");
});

it("refuses an active expired entry but continues revocation with the terminal marker", async () => {
  await makeTemporary(new Date(Date.now() - 60_000).toISOString());
  const row = await seedKey();
  const deps = { repo: h.repo, credentialCacheWriter: writer };
  await expect(writeClientKeyCache(deps, row, false, ids.orgId, true)).rejects.toThrow("expired");
  const key = clientKeyCacheKey(await sha256Hex(row.keyMaterial));
  expect(await env.CREDENTIAL_STORE.get(key)).toBeNull();
  const revoked = await h.repo.credentials.updateClientKey(scope, row.keyId, { revokedAt: NOW });
  if (!revoked) throw new Error("credential revoke fixture missing");
  await writeClientKeyCache(deps, revoked, true, ids.orgId, true);
  expect(await env.CREDENTIAL_STORE.get(credentialRevocationCacheKey(key))).toBe(
    TERMINAL_CREDENTIAL_REVOCATION_MARKER,
  );
  expect(await readCache(key)).toMatchObject({ credentialSchemaVersion: 3, revoked: true });
});
