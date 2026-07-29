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
          keyId: "ck_a",
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
          keyId: "ak_a",
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
          keyId: "ck_race",
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

  it("does not reopen a Client Key allowlist after a restriction has serialized", async () => {
    const writes = new Map<string, string>();
    const writer = new AuthoritativeSerialWriter(writes);
    const stale = {
      keyId: "ck_restrict",
      appId: "app_a",
      environmentId: "env_a",
      keyMaterial: "pk_restrict",
      originAllowlist: null,
      rateLimitRps: null,
      organizationId: "org_a",
      revokedAt: null,
    };

    // The restriction is authoritative in D1 first; the backfill then carries the
    // pre-restriction (open) allowlist and must be rejected rather than land.
    // Asserted through the writer's authority check, not through write ordering:
    // two concurrent writes race on crypto.subtle.digest, so which one lands last
    // is not something this test can control.
    writer.originAllowlist = ["https://app.example"];
    await writeClientKeyCache(
      { credentialCacheWriter: writerAccess(writer) },
      { ...stale, originAllowlist: '["https://app.example"]' },
      false,
      "org_a",
      true,
    );
    await expect(
      backfillCredentialCaches(
        { credentialCacheWriter: writerAccess(writer) },
        { clientKeys: [stale], apiKeys: [] },
      ),
    ).rejects.toThrow("Client Key restrictions are stale");

    const raw = writes.get(clientKeyCacheKey(await sha256Hex(stale.keyMaterial)));
    expect(cacheEnvelope.parse(JSON.parse(raw as string)).data.originAllowlist).toEqual([
      "https://app.example",
    ]);
  });
});

describe("credential cache backfill authoritative ordering", () => {
  it("rejects a stale active backfill after revocation has already serialized", async () => {
    const writes = new Map<string, string>();
    const writer = new AuthoritativeSerialWriter(writes);
    const row = {
      keyId: "ck_revocation_first",
      appId: "app_a",
      environmentId: "env_a",
      keyMaterial: "pk_revocation_first",
      originAllowlist: null,
      rateLimitRps: null,
      organizationId: "org_a",
      revokedAt: null,
    };

    writer.revoked = true;
    await writeClientKeyCache(
      { credentialCacheWriter: writerAccess(writer) },
      row,
      true,
      "org_a",
      true,
    );
    await expect(
      backfillCredentialCaches(
        { credentialCacheWriter: writerAccess(writer) },
        { clientKeys: [row], apiKeys: [] },
      ),
    ).rejects.toThrow("revocation state is stale");

    const raw = writes.get(clientKeyCacheKey(await sha256Hex(row.keyMaterial)));
    expect(cacheEnvelope.parse(JSON.parse(raw as string)).data.revoked).toBe(true);
  });
});

class SerialWriter implements CredentialCacheWriter {
  private tail = Promise.resolve();

  constructor(private readonly writes: Map<string, string>) {}

  put({ key, value }: Parameters<CredentialCacheWriter["put"]>[0]): Promise<void> {
    const write = this.tail.then(() => {
      this.writes.set(key, value);
    });
    this.tail = write;
    return write;
  }
}

/** Mirrors the CredentialCacheWriterDurableObject authority checks. */
class AuthoritativeSerialWriter extends SerialWriter {
  revoked = false;
  originAllowlist: string[] | null = null;

  override async put(write: Parameters<CredentialCacheWriter["put"]>[0]): Promise<void> {
    const candidate = cacheEnvelope.parse(JSON.parse(write.value)).data;
    if (candidate.revoked !== this.revoked) {
      throw new Error("credential cache write rejected: revocation state is stale");
    }
    const candidateAllowlist =
      candidate.kind === "client_key" ? (candidate.originAllowlist ?? null) : null;
    if (JSON.stringify(candidateAllowlist) !== JSON.stringify(this.originAllowlist)) {
      throw new Error("credential cache write rejected: Client Key restrictions are stale");
    }
    await super.put(write);
  }
}

function writerAccess(writer: CredentialCacheWriter) {
  return { writerFor: () => writer };
}
