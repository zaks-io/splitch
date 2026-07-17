import { CredentialCacheKVSchema, clientKeyCacheKey, kvEnvelope } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import {
  backfillCredentialCaches,
  type CredentialCacheWriter,
  type CredentialCacheBackfillRows,
  sha256Hex,
  writeClientKeyCache,
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

  it("serializes a stale active backfill before a concurrent revocation for the same key", async () => {
    const writes = new Map<string, string>();
    const writer = new SerialWriter(writes);
    const rows: CredentialCacheBackfillRows = {
      clientKeys: [
        {
          appId: "app_a",
          environmentId: "env_a",
          keyMaterial: "pk_race",
          originAllowlist: null,
          rateLimitRps: null,
          organizationId: "org_a",
          revokedAt: null,
        },
      ],
      apiKeys: [],
    };
    const stale = rows.clientKeys[0];
    if (stale === undefined) throw new Error("test fixture must contain a Client Key");

    await Promise.all([
      backfillCredentialCaches({ credentialCacheWriter: writerAccess(writer) }, rows),
      writeClientKeyCache(
        { credentialCacheWriter: writerAccess(writer) },
        stale,
        true,
        "org_a",
        true,
      ),
    ]);

    const raw = writes.get(clientKeyCacheKey(await sha256Hex("pk_race")));
    expect(cacheEnvelope.parse(JSON.parse(raw as string)).data.revoked).toBe(true);
  });

  it("does not reopen a Client Key allowlist after a concurrent restriction", async () => {
    const writes = new Map<string, string>();
    const writer = new SerialWriter(writes);
    const stale = {
      appId: "app_a",
      environmentId: "env_a",
      keyMaterial: "pk_restrict",
      originAllowlist: null,
      rateLimitRps: null,
      organizationId: "org_a",
      revokedAt: null,
    };

    await Promise.all([
      backfillCredentialCaches(
        { credentialCacheWriter: writerAccess(writer) },
        { clientKeys: [stale], apiKeys: [] },
      ),
      writeClientKeyCache(
        { credentialCacheWriter: writerAccess(writer) },
        { ...stale, originAllowlist: '["https://app.example"]' },
        false,
        "org_a",
        true,
      ),
    ]);

    const raw = writes.get(clientKeyCacheKey(await sha256Hex(stale.keyMaterial)));
    expect(cacheEnvelope.parse(JSON.parse(raw as string)).data.originAllowlist).toEqual([
      "https://app.example",
    ]);
  });
});

class SerialWriter implements CredentialCacheWriter {
  private tail = Promise.resolve();

  constructor(private readonly writes: Map<string, string>) {}

  put(key: string, value: string): Promise<void> {
    const write = this.tail.then(() => {
      this.writes.set(key, value);
    });
    this.tail = write;
    return write;
  }
}

function writerAccess(writer: CredentialCacheWriter) {
  return { writerFor: () => writer };
}
