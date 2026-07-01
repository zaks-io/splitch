import { describe, expect, it } from "vitest";
import { makeKvRevocationStore } from "./revocation.js";

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

describe("KV revocation store", () => {
  it("uses Cloudflare KV's 60 second minimum expiration TTL", async () => {
    const { kv, puts } = makeKv();
    const store = makeKvRevocationStore(kv);

    await store.revoke("user_last_minute", 1);

    expect(puts[0]).toMatchObject({
      key: "revoked:user_last_minute",
      value: "1",
      options: { expirationTtl: 60 },
    });
  });

  it("ceilings longer revocation TTLs without extending them to the minimum", async () => {
    const { kv, puts } = makeKv();
    const store = makeKvRevocationStore(kv);

    await store.revoke("user_longer", 61.2);

    expect(puts[0]?.options?.expirationTtl).toBe(62);
    await expect(store.isRevoked("user_longer")).resolves.toBe(true);
  });
});
