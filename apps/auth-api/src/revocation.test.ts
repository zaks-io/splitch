import { describe, expect, it } from "vitest";
import { makeKvRevocationStore } from "./revocation";

function makeKv(): {
  kv: KVNamespace;
  puts: Array<{ key: string; value: string; options?: KVNamespacePutOptions }>;
} {
  const entries = new Map<string, string>();
  const puts: Array<{ key: string; value: string; options?: KVNamespacePutOptions }> = [];
  const kv = {
    async put(key: string, value: string, options?: KVNamespacePutOptions): Promise<void> {
      puts.push({ key, value, options });
      entries.set(key, value);
    },
    async get(key: string): Promise<string | null> {
      return entries.get(key) ?? null;
    },
  } as Pick<KVNamespace, "put" | "get"> as KVNamespace;

  return { kv, puts };
}

const REVOKED_AT = 1_780_000_000;

describe("KV revocation store", () => {
  it("uses Cloudflare KV's 60 second minimum expiration TTL", async () => {
    const { kv, puts } = makeKv();
    const store = makeKvRevocationStore(kv);

    await store.revoke("user_last_minute", REVOKED_AT, 1);

    expect(puts[0]).toMatchObject({
      key: "revoked:user_last_minute",
      value: String(REVOKED_AT),
      options: { expirationTtl: 60 },
    });
  });

  it("ceilings longer revocation TTLs without extending them to the minimum", async () => {
    const { kv, puts } = makeKv();
    const store = makeKvRevocationStore(kv);

    await store.revoke("user_longer", REVOKED_AT, 61.2);

    expect(puts[0]?.options?.expirationTtl).toBe(62);
  });

  it("revokes tokens issued up to the revocation and admits tokens issued after it", async () => {
    const { kv } = makeKv();
    const store = makeKvRevocationStore(kv);

    await store.revoke("user_relogin", REVOKED_AT, 3600);

    await expect(store.isRevoked("user_relogin", REVOKED_AT - 60)).resolves.toBe(true);
    await expect(store.isRevoked("user_relogin", REVOKED_AT)).resolves.toBe(true);
    await expect(store.isRevoked("user_relogin", REVOKED_AT + 1)).resolves.toBe(false);
    await expect(store.isRevoked("user_other", REVOKED_AT - 60)).resolves.toBe(false);
  });
});
