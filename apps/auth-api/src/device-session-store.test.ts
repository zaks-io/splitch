import { describe, expect, it } from "vitest";
import { makeKvDeviceRefreshSessionStore } from "./device-session-store.js";

function makeKv(): {
  kv: KVNamespace;
  keys: string[];
} {
  const entries = new Map<string, string>();
  const keys: string[] = [];
  const kv = {
    async put(key: string, value: string): Promise<void> {
      keys.push(key);
      entries.set(key, value);
    },
    async get(key: string): Promise<string | null> {
      return entries.get(key) ?? null;
    },
  } as Pick<KVNamespace, "put" | "get"> as KVNamespace;

  return { kv, keys };
}

describe("device refresh session store", () => {
  it("stores provider session ids behind hashed refresh-token keys", async () => {
    const { kv, keys } = makeKv();
    const store = makeKvDeviceRefreshSessionStore(kv);

    await store.remember("refresh_secret", "session_workos");

    expect(keys[0]).toMatch(/^device-refresh-session:/);
    expect(keys[0]).not.toContain("refresh_secret");
    await expect(store.lookup("refresh_secret")).resolves.toBe("session_workos");
    await expect(store.lookup("other_refresh_secret")).resolves.toBeNull();
  });
});
