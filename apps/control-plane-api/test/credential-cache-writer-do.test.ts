import { env } from "cloudflare:workers";
import {
  CredentialCacheKVSchema,
  CURRENT_KV_SCHEMA_VERSION,
  clientKeyCacheKey,
  credentialRevocationCacheKey,
  kvEnvelope,
  TERMINAL_CREDENTIAL_REVOCATION_MARKER,
} from "@splitch/contracts";
import { beforeAll, expect, it } from "vitest";
import { sha256Hex } from "../src/credential-cache";
import { resetOrganizationGraph, seedEnvironment, seedOrgApp } from "../src/test-seeds";

const NOW = "2026-08-07T00:00:00.000Z";
const REVOKED_KEY = {
  keyId: "ck_writer_revoked",
  environmentId: "env_writer_revoked",
  material: "pk_writer_revoked",
  revoked: true,
} as const;
const ACTIVE_KEY = {
  keyId: "ck_writer_active",
  environmentId: "env_writer_active",
  material: "pk_writer_active",
  revoked: false,
} as const;

beforeAll(async () => {
  await resetOrganizationGraph(env.DB);
  await seedOrgApp(env.DB, {
    orgId: "org_writer",
    orgName: "Writer Marker Proof",
    appId: "app_writer",
    appName: "Writer Marker Proof",
    appKey: "writer-marker-proof",
  });
  await seedEnvironment(env.DB, {
    appId: "app_writer",
    environmentId: REVOKED_KEY.environmentId,
    key: "production",
  });
  await seedEnvironment(env.DB, {
    appId: "app_writer",
    environmentId: ACTIVE_KEY.environmentId,
    key: "development",
  });
  await env.DB.batch([REVOKED_KEY, ACTIVE_KEY].map(insertClientKey));
});

it("writes the terminal marker for a revoked credential through the production Durable Object", async () => {
  const cacheKey = await writeThroughProductionWriter(REVOKED_KEY);

  await expect(env.CREDENTIAL_STORE.get(credentialRevocationCacheKey(cacheKey))).resolves.toBe(
    TERMINAL_CREDENTIAL_REVOCATION_MARKER,
  );
});

it("leaves the terminal marker absent for an active production Durable Object write", async () => {
  const cacheKey = await writeThroughProductionWriter(ACTIVE_KEY);

  await expect(
    env.CREDENTIAL_STORE.get(credentialRevocationCacheKey(cacheKey)),
  ).resolves.toBeNull();
});

function insertClientKey(key: typeof REVOKED_KEY | typeof ACTIVE_KEY): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO client_keys
       (key_id, app_id, environment_id, key_material, created_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(key.keyId, "app_writer", key.environmentId, key.material, NOW, key.revoked ? NOW : null);
}

async function writeThroughProductionWriter(
  key: typeof REVOKED_KEY | typeof ACTIVE_KEY,
): Promise<string> {
  const cacheKey = clientKeyCacheKey(await sha256Hex(key.material));
  const value = JSON.stringify(
    kvEnvelope(CredentialCacheKVSchema).parse({
      schemaVersion: CURRENT_KV_SCHEMA_VERSION,
      data: {
        appId: "app_writer",
        environmentId: key.environmentId,
        credentialSchemaVersion: 2,
        organizationId: "org_writer",
        kind: "client_key",
        scopes: ["data-plane:evaluate"],
        originAllowlist: null,
        rateLimitRps: null,
        revoked: key.revoked,
        cachedAt: NOW,
      },
    }),
  );

  await env.CREDENTIAL_CACHE_WRITER.getByName(cacheKey).put({
    key: cacheKey,
    value,
    ...(key.revoked ? { options: { expirationTtl: 300 } } : {}),
    credential: { kind: "client_key", keyId: key.keyId },
  });
  return cacheKey;
}
