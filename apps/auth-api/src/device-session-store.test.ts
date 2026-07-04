import { createRepository } from "@splitch/db";
import { describe, expect, it } from "vitest";
import { makeD1DeviceRefreshSessionStore } from "./device-session-store";
import { makeLocalBindings } from "./test-fixtures";

const NOW_MS = 1_780_000_000_000;

function staleMissCache(keys: string[] = []): KVNamespace {
  return {
    async get(_key: string) {
      return null;
    },
    async put(key: string, _value: string) {
      keys.push(key);
    },
  } as unknown as KVNamespace;
}

describe("D1 device refresh session store", () => {
  it("falls back to D1 when KV stale-misses after remember", async () => {
    const local = await makeLocalBindings();
    try {
      const store = makeD1DeviceRefreshSessionStore(createRepository(local.d1), {
        cache: staleMissCache(),
        now: () => NOW_MS,
      });

      await store.remember("provider-refresh-token", "session_workos");

      await expect(store.lookup("provider-refresh-token")).resolves.toBe("session_workos");
    } finally {
      await local.dispose();
    }
  });

  it("returns null for unknown refresh tokens", async () => {
    const local = await makeLocalBindings();
    try {
      const store = makeD1DeviceRefreshSessionStore(createRepository(local.d1), {
        cache: staleMissCache(),
        now: () => NOW_MS,
      });

      await expect(store.lookup("unknown-refresh-token")).resolves.toBeNull();
    } finally {
      await local.dispose();
    }
  });

  it("stores only hashed refresh tokens in D1 and KV keys", async () => {
    const local = await makeLocalBindings();
    try {
      const keys: string[] = [];
      const rawRefreshToken = "provider-refresh-token-secret";
      const store = makeD1DeviceRefreshSessionStore(createRepository(local.d1), {
        cache: staleMissCache(keys),
        now: () => NOW_MS,
      });

      await store.remember(rawRefreshToken, "session_workos");

      const row = await local.d1
        .prepare(
          "SELECT refresh_token_hash, provider_session_id FROM device_refresh_sessions LIMIT 1",
        )
        .first<{ refresh_token_hash: string; provider_session_id: string }>();
      expect(row).toMatchObject({ provider_session_id: "session_workos" });
      expect(row?.refresh_token_hash).not.toBe(rawRefreshToken);
      expect(row?.refresh_token_hash).not.toContain(rawRefreshToken);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.every((key) => !key.includes(rawRefreshToken))).toBe(true);
    } finally {
      await local.dispose();
    }
  });
});
