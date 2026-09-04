import {
  apiKeyCacheKey,
  CredentialCacheKVSchema,
  clientKeyCacheKey,
  credentialRevocationCacheKey,
  kvEnvelope,
} from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { makeDataPlaneAuthResolver } from "../../evaluation-api/src/data-plane-auth";
import {
  backfillCredentialCaches,
  type CredentialCacheBackfillRows,
  sha256Hex,
  writeClientKeyCache,
} from "./credential-cache";
import {
  AuthoritativeSerialWriter,
  OrderedWriter,
  StaleBackfillWinsStore,
  writerAccess,
} from "./credential-cache-writers-fixture";

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

    const value = writes.get(apiKeyCacheKey("hash_a"));
    expect(cacheEnvelope.parse(JSON.parse(value as string)).data).toMatchObject({
      organizationId: "org_a",
      revoked: true,
    });
  });

  it("keeps the terminal marker when a stale active raw KV put lands last", async () => {
    const writes = new Map<string, string>();
    const cacheKey = clientKeyCacheKey(await sha256Hex("pk_race"));
    const store = new StaleBackfillWinsStore(writes, cacheKey);
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
      backfillCredentialCaches({ credentialStore: store as unknown as KVNamespace }, rows),
      writeClientKeyCache(
        { credentialStore: store as unknown as KVNamespace },
        stale,
        true,
        "org_a",
        true,
      ),
    ]);

    const raw = writes.get(cacheKey);
    expect(cacheEnvelope.parse(JSON.parse(raw as string)).data.revoked).toBe(false);
    expect(writes.get(credentialRevocationCacheKey(cacheKey))).toBeDefined();

    await expect(
      makeDataPlaneAuthResolver(store)(
        new Request("https://edge.test/api/sdk/evaluate", {
          headers: { authorization: "Bearer pk_race" },
        }),
      ),
    ).resolves.toEqual({ ok: false, reason: "CREDENTIAL_REVOKED" });
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

describe("credential cache backfill concurrency", () => {
  /**
   * The serialized test above proves the authority check; this proves the
   * property that check exists for, which is what the pre-rewrite test was
   * really asserting: however a backfill and a restriction interleave, the
   * cached allowlist ends up restricted and the key is never reopened.
   *
   * Both interleavings are driven explicitly rather than raced, because the two
   * paths race on crypto.subtle.digest and whichever wins is not something a
   * test can control (SPL-178 covers a sibling test with the same disease). The
   * assertion is deliberately identical for both orders: that is the property.
   */
  it.each([{ first: "backfill" as const }, { first: "restriction" as const }])(
    "never reopens a restricted Client Key allowlist when the $first write lands first",
    async ({ first }) => {
      const writes = new Map<string, string>();
      const writer = new OrderedWriter(writes, first);
      const row = {
        keyId: "ck_race",
        appId: "app_a",
        environmentId: "env_a",
        keyMaterial: "pk_race_allowlist",
        originAllowlist: null,
        rateLimitRps: null,
        organizationId: "org_a",
        revokedAt: null,
      };

      const settled = await Promise.allSettled([
        backfillCredentialCaches(
          { credentialCacheWriter: writerAccess(writer) },
          { clientKeys: [row], apiKeys: [] },
        ),
        writeClientKeyCache(
          { credentialCacheWriter: writerAccess(writer) },
          { ...row, originAllowlist: '["https://app.example"]' },
          false,
          "org_a",
          true,
        ),
      ]);

      // The restriction always lands; the backfill may be refused as stale, and
      // which of those happens is exactly what must not matter to the outcome.
      expect(settled[1]?.status).toBe("fulfilled");
      const raw = writes.get(clientKeyCacheKey(await sha256Hex(row.keyMaterial)));
      expect(cacheEnvelope.parse(JSON.parse(raw as string)).data.originAllowlist).toEqual([
        "https://app.example",
      ]);
    },
  );
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
