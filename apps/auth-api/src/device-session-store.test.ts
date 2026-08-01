import { createRepository } from "@splitch/db";
import { describe, expect, it } from "vitest";
import { makeD1DeviceRefreshSessionStore } from "./device-session-store";
import { makeLocalBindings } from "./test-fixtures";

const NOW_MS = 1_780_000_000_000;
const SESSION = {
  providerSessionId: "session_workos",
  userId: "user_workos",
  providerOrganizationId: "org_workos",
  selectedAppSelector: "app_selected",
};

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

      await store.remember("provider-refresh-token", SESSION);

      await expect(store.lookup("provider-refresh-token")).resolves.toEqual(SESSION);
    } finally {
      await local.dispose();
    }
  });

  it("round-trips an unbound cold-start session through the NOT NULL '' columns", async () => {
    const local = await makeLocalBindings();
    try {
      const store = makeD1DeviceRefreshSessionStore(createRepository(local.d1), {
        cache: staleMissCache(),
        now: () => NOW_MS,
      });

      await store.remember("cold-start-token", {
        ...SESSION,
        providerOrganizationId: null,
        selectedAppSelector: null,
      });

      await expect(store.lookup("cold-start-token")).resolves.toEqual({
        ...SESSION,
        providerOrganizationId: null,
        selectedAppSelector: null,
      });
    } finally {
      await local.dispose();
    }
  });

  it("reads a legacy row that stored a full membership scope as its selector", async () => {
    const local = await makeLocalBindings();
    try {
      const store = makeD1DeviceRefreshSessionStore(createRepository(local.d1), {
        cache: staleMissCache(),
        now: () => NOW_MS,
      });
      await store.remember("legacy-token", SESSION);
      await local.d1
        .prepare("UPDATE device_refresh_sessions SET selected_app_scope = ?")
        .bind("app:app_selected:owner")
        .run();

      await expect(store.lookup("legacy-token")).resolves.toMatchObject({
        selectedAppSelector: "app_selected",
      });
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

      await store.remember(rawRefreshToken, SESSION);

      const row = await local.d1
        .prepare(
          "SELECT refresh_token_hash, provider_session_id, user_id, provider_organization_id, selected_app_scope FROM device_refresh_sessions LIMIT 1",
        )
        .first<{
          refresh_token_hash: string;
          provider_session_id: string;
          user_id: string;
          provider_organization_id: string;
          selected_app_scope: string;
        }>();
      expect(row).toMatchObject({
        provider_session_id: "session_workos",
        user_id: "user_workos",
        provider_organization_id: "org_workos",
        selected_app_scope: "app_selected",
      });
      expect(row?.refresh_token_hash).not.toBe(rawRefreshToken);
      expect(row?.refresh_token_hash).not.toContain(rawRefreshToken);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.every((key) => !key.includes(rawRefreshToken))).toBe(true);
    } finally {
      await local.dispose();
    }
  });

  it("rotates durable authority and removes the previous refresh-token hash", async () => {
    const local = await makeLocalBindings();
    try {
      const store = makeD1DeviceRefreshSessionStore(createRepository(local.d1), {
        cache: staleMissCache(),
        now: () => NOW_MS,
      });
      await store.remember("refresh-old", SESSION);
      await store.rotate("refresh-old", "refresh-new", {
        ...SESSION,
        selectedAppSelector: "app_other",
      });

      await expect(store.lookup("refresh-old")).resolves.toBeNull();
      await expect(store.lookup("refresh-new")).resolves.toMatchObject({
        selectedAppSelector: "app_other",
      });
    } finally {
      await local.dispose();
    }
  });
});
