import { CredentialCacheKVSchema, clientKeyCacheKey, kvEnvelope } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import {
  backfillCredentialCaches,
  type CredentialCacheBackfillRows,
  sha256Hex,
} from "./credential-cache";

const cacheEnvelope = kvEnvelope(CredentialCacheKVSchema);

describe("credential cache schema-v1 backfill", () => {
  it("rewrites active credentials with the Organization joined from D1 App authority", async () => {
    const writes = new Map<string, string>();
    const credentialStore = {
      put: async (key: string, value: string) => {
        writes.set(key, value);
      },
    } as unknown as KVNamespace;
    const rows: CredentialCacheBackfillRows = {
      clientKeys: [
        {
          appId: "app_a",
          environmentId: "env_a",
          keyMaterial: "pk_a",
          originAllowlist: null,
          rateLimitRps: null,
          organizationId: "org_a",
          revokedAt: null,
        },
      ],
      apiKeys: [],
    };

    await expect(backfillCredentialCaches({ credentialStore }, rows)).resolves.toBe(1);

    const raw = writes.get(clientKeyCacheKey(await sha256Hex("pk_a")));
    expect(raw).toBeDefined();
    expect(cacheEnvelope.parse(JSON.parse(raw as string)).data).toMatchObject({
      credentialSchemaVersion: 2,
      organizationId: "org_a",
      appId: "app_a",
      environmentId: "env_a",
      revoked: false,
    });
  });

  it("does not make revoked legacy entries active during the rewrite", async () => {
    const writes = new Map<string, string>();
    const credentialStore = {
      put: async (key: string, value: string) => {
        writes.set(key, value);
      },
    } as unknown as KVNamespace;
    const rows: CredentialCacheBackfillRows = {
      clientKeys: [],
      apiKeys: [
        {
          appId: "app_a",
          environmentId: "env_a",
          keyHash: "hash_a",
          scopes: '["data-plane:evaluate"]',
          organizationId: "org_a",
          revokedAt: "2026-07-01T00:00:00.000Z",
        },
      ],
    };

    await backfillCredentialCaches({ credentialStore }, rows);

    const value = [...writes.values()][0];
    expect(cacheEnvelope.parse(JSON.parse(value as string)).data).toMatchObject({
      organizationId: "org_a",
      revoked: true,
    });
  });
});
