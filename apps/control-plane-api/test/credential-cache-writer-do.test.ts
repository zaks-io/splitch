import { env } from "cloudflare:workers";
import {
  CredentialCacheKVSchema,
  CURRENT_KV_SCHEMA_VERSION,
  credentialRevocationCacheKey,
  kvEnvelope,
  TERMINAL_CREDENTIAL_REVOCATION_MARKER,
} from "@splitch/contracts";
import { beforeAll, expect, it } from "vitest";
import { resetOrganizationGraph, seedEnvironment, seedOrgApp } from "../src/test-seeds";

const KEY_ID = "ck_writer_revoked";
const CACHE_KEY = "ck:writer-revocation-proof";
const NOW = "2026-08-07T00:00:00.000Z";

beforeAll(async () => {
  await resetOrganizationGraph(env.DB);
  await seedOrgApp(env.DB, {
    orgId: "org_writer_revoked",
    orgName: "Writer Revocation Proof",
    appId: "app_writer_revoked",
    appName: "Writer Revocation Proof",
    appKey: "writer-revocation-proof",
  });
  await seedEnvironment(env.DB, {
    appId: "app_writer_revoked",
    environmentId: "env_writer_revoked",
    key: "production",
  });
  await env.DB.prepare(
    `INSERT INTO client_keys
       (key_id, app_id, environment_id, key_material, created_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(KEY_ID, "app_writer_revoked", "env_writer_revoked", "pk_writer_revoked", NOW, NOW)
    .run();
});

it("writes the terminal marker through the production credential-cache Durable Object", async () => {
  const value = JSON.stringify(
    kvEnvelope(CredentialCacheKVSchema).parse({
      schemaVersion: CURRENT_KV_SCHEMA_VERSION,
      data: {
        appId: "app_writer_revoked",
        environmentId: "env_writer_revoked",
        credentialSchemaVersion: 2,
        organizationId: "org_writer_revoked",
        kind: "client_key",
        scopes: ["data-plane:evaluate"],
        originAllowlist: null,
        rateLimitRps: null,
        revoked: true,
        cachedAt: NOW,
      },
    }),
  );

  await env.CREDENTIAL_CACHE_WRITER.getByName(CACHE_KEY).put({
    key: CACHE_KEY,
    value,
    options: { expirationTtl: 300 },
    credential: { kind: "client_key", keyId: KEY_ID },
  });

  await expect(env.CREDENTIAL_STORE.get(credentialRevocationCacheKey(CACHE_KEY))).resolves.toBe(
    TERMINAL_CREDENTIAL_REVOCATION_MARKER,
  );
});
