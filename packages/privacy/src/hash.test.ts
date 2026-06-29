import { describe, expect, it } from "vitest";
import { computeTargetingKeyHash, keyVersionOf } from "./hash.js";
import type { KeyVersion, SaltStore } from "./salt-store.js";

// Obvious fake test salts — NOT real secrets. Keyed per (app, version).
const FAKE_SALTS: Record<string, Record<string, string>> = {
  app_a: { v1: "test-salt-app-a-v1", v2: "test-salt-app-a-v2" },
  app_b: { v1: "test-salt-app-b-v1" },
};

function fakeStore(current: Record<string, KeyVersion>): SaltStore {
  return {
    async currentKeyVersion(appId) {
      const version = current[appId];
      if (!version) throw new Error(`no current version for ${appId}`);
      return version;
    },
    async saltFor(appId, keyVersion) {
      const salt = FAKE_SALTS[appId]?.[keyVersion];
      if (salt === undefined) throw new Error(`no salt for ${appId}/${keyVersion}`);
      return new TextEncoder().encode(salt);
    },
  };
}

const store = fakeStore({ app_a: "v2", app_b: "v1" });

describe("computeTargetingKeyHash", () => {
  it("is deterministic for the same (keyVersion, salt, idType, targetingKey)", async () => {
    const a = await computeTargetingKeyHash(store, {
      appId: "app_a",
      idType: "user",
      targetingKey: "user-123",
    });
    const b = await computeTargetingKeyHash(store, {
      appId: "app_a",
      idType: "user",
      targetingKey: "user-123",
    });
    expect(a).toBe(b);
  });

  it("prefixes the output with the key_version", async () => {
    const hash = await computeTargetingKeyHash(store, {
      appId: "app_a",
      idType: "user",
      targetingKey: "user-123",
    });
    expect(hash.startsWith("v2:")).toBe(true);
    expect(keyVersionOf(hash)).toBe("v2");
  });

  it("NEVER echoes the raw Targeting Key in the output", async () => {
    const targetingKey = "alice@example.com";
    const hash = await computeTargetingKeyHash(store, {
      appId: "app_a",
      idType: "email",
      targetingKey,
    });
    expect(hash.includes(targetingKey)).toBe(false);
    expect(hash.includes("alice")).toBe(false);
  });

  it("differs by idType, by targetingKey, and by salt version", async () => {
    const base = { appId: "app_a", idType: "user", targetingKey: "u1" } as const;
    const byIdType = await computeTargetingKeyHash(store, { ...base, idType: "email" });
    const byKey = await computeTargetingKeyHash(store, { ...base, targetingKey: "u2" });
    const v1 = await computeTargetingKeyHash(store, { ...base, keyVersion: "v1" });
    const v2 = await computeTargetingKeyHash(store, base);
    const all = new Set([byIdType, byKey, v1, v2]);
    expect(all.size).toBe(4);
  });

  it("recomputes the same hash for a pinned historical version (lazy rotation)", async () => {
    const input = { appId: "app_a", idType: "user", targetingKey: "u1", keyVersion: "v1" } as const;
    const first = await computeTargetingKeyHash(store, input);
    const second = await computeTargetingKeyHash(store, input);
    expect(first).toBe(second);
    expect(first.startsWith("v1:")).toBe(true);
  });

  it("fails loud when the salt version is unknown (no silent fallback)", async () => {
    await expect(
      computeTargetingKeyHash(store, {
        appId: "app_b",
        idType: "user",
        targetingKey: "u1",
        keyVersion: "v9",
      }),
    ).rejects.toThrow();
  });

  it("fails loud on an empty salt instead of hashing under a known weak key", async () => {
    const emptyStore: SaltStore = {
      async currentKeyVersion() {
        return "v1";
      },
      async saltFor() {
        return new Uint8Array();
      },
    };
    await expect(
      computeTargetingKeyHash(emptyStore, { appId: "x", idType: "user", targetingKey: "u" }),
    ).rejects.toThrow(/empty salt/);
  });
});

describe("keyVersionOf", () => {
  it("throws on a hash with no version prefix", () => {
    expect(() => keyVersionOf("deadbeef")).toThrow();
  });
});
