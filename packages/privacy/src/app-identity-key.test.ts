import { describe, expect, it } from "vitest";
import {
  deriveAppIdentityKek,
  generateAppIdentityKey,
  nextAppIdentityVersion,
  unwrapAppIdentityKey,
  wrapAppIdentityKey,
} from "./app-identity-key";
import {
  advanceAppIdentityEpoch,
  defaultAppEntityIdentityRecordKey,
  makeKvAppIdentityStore,
  makeMemoryAppIdentityStore,
  mintInitialAppIdentityRecord,
  rewrapKvAppIdentityRecord,
} from "./app-identity-store";
import { makeIdentitySaltStore } from "./derived-salt-store";
import { computeRetainedTargetingKeyHashes } from "./entity-privacy";
import { computeTargetingKeyHash } from "./hash";
import { toHex } from "./hmac";

const ROOT = "test-root-secret-do-not-use";
const NEXT_ROOT = "rotated-root-secret-do-not-use";

function memoryKv() {
  const values = new Map<string, string>();
  return {
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async put(key: string, value: string) {
      values.set(key, value);
    },
    raw(key: string) {
      return values.get(key);
    },
  };
}

describe("app identity key wrap", () => {
  it("unwraps the same random key after a wrap", async () => {
    const key = generateAppIdentityKey();
    const kek = await deriveAppIdentityKek(ROOT, "app_1");
    const wrapped = await wrapAppIdentityKey(kek, key);
    expect(toHex(await unwrapAppIdentityKey(kek, wrapped))).toBe(toHex(key));
    expect(wrapped.iv).not.toBe(wrapped.ciphertext);
  });

  it("fails loud when the KEK does not match the wrapper", async () => {
    const key = generateAppIdentityKey();
    const wrapped = await wrapAppIdentityKey(await deriveAppIdentityKek(ROOT, "app_1"), key);
    await expect(
      unwrapAppIdentityKey(await deriveAppIdentityKek(NEXT_ROOT, "app_1"), wrapped),
    ).rejects.toThrow(/failed to unwrap/);
  });

  it("binds the KEK to the App so two Apps do not share wrap material", async () => {
    const left = toHex(await deriveAppIdentityKek(ROOT, "app_1"));
    const right = toHex(await deriveAppIdentityKek(ROOT, "app_2"));
    expect(left).not.toBe(right);
  });

  it("rejects an empty root, empty App ID, or a separator in the App ID", async () => {
    await expect(deriveAppIdentityKek("", "app_1")).rejects.toThrow(/empty root/);
    await expect(deriveAppIdentityKek(ROOT, "")).rejects.toThrow(/appId/);
    await expect(deriveAppIdentityKek(ROOT, "app:1")).rejects.toThrow(/appId/);
  });

  it("advances app-vN labels and rejects historical prefixes", () => {
    expect(nextAppIdentityVersion("app-v1")).toBe("app-v2");
    expect(nextAppIdentityVersion("app-v9")).toBe("app-v10");
    expect(() => nextAppIdentityVersion("local-v1")).toThrow(/cannot advance/);
  });
});

describe("App identity store", () => {
  const input = { appId: "app_1", idType: "user", targetingKey: "user-123" } as const;

  it("keeps current hashes stable across routine root rewrap", async () => {
    const kv = memoryKv();
    const firstStore = makeKvAppIdentityStore({ kv, rootSecret: ROOT });
    const first = makeIdentitySaltStore({ rootSecret: ROOT, identityStore: firstStore });
    const before = await computeTargetingKeyHash(first, input);

    await rewrapKvAppIdentityRecord({
      kv,
      appId: input.appId,
      oldRootSecret: ROOT,
      newRootSecret: NEXT_ROOT,
    });
    const rotated = makeIdentitySaltStore({
      rootSecret: NEXT_ROOT,
      identityStore: makeKvAppIdentityStore({ kv, rootSecret: NEXT_ROOT }),
    });
    expect(await computeTargetingKeyHash(rotated, input)).toBe(before);
    expect(kv.raw(defaultAppEntityIdentityRecordKey(input.appId))).toEqual(expect.any(String));
  });

  it("retains both first-mint keys when a later mint overwrites", async () => {
    const kv = memoryKv();
    const store = makeKvAppIdentityStore({ kv, rootSecret: ROOT });
    const first = mintInitialAppIdentityRecord();
    const second = mintInitialAppIdentityRecord();
    const firstKey = first.epochs[0]?.key;
    const secondKey = second.epochs[0]?.key;
    expect(firstKey).toBeDefined();
    expect(secondKey).toBeDefined();
    if (firstKey === undefined || secondKey === undefined) {
      throw new Error("minted App identity record is missing its first epoch");
    }
    expect(toHex(firstKey)).not.toBe(toHex(secondKey));
    await store.save(input.appId, first, { merge: false });
    const saltStore = makeIdentitySaltStore({ rootSecret: ROOT, identityStore: store });
    const hashA = await computeTargetingKeyHash(saltStore, input);
    await store.save(input.appId, second);
    const loaded = await store.load(input.appId);
    expect(loaded?.currentVersion).toBe("app-v1");
    expect(loaded?.epochs).toHaveLength(2);
    expect(toHex(loaded?.epochs[0]?.key ?? new Uint8Array())).toBe(toHex(firstKey));
    expect(toHex(loaded?.epochs[1]?.key ?? new Uint8Array())).toBe(toHex(secondKey));
    const retained = await computeRetainedTargetingKeyHashes(saltStore, input);
    expect(retained).toContain(hashA);
    expect(await computeTargetingKeyHash(saltStore, input)).toBe(hashA);
  });

  it("keeps memory-store keys stable for one App and unlinkable across Apps", async () => {
    const identityStore = makeMemoryAppIdentityStore();
    const saltStore = makeIdentitySaltStore({ rootSecret: ROOT, identityStore });
    const appA = await computeTargetingKeyHash(saltStore, input);
    const again = await computeTargetingKeyHash(saltStore, input);
    const appB = await computeTargetingKeyHash(saltStore, { ...input, appId: "app_2" });
    expect(again).toBe(appA);
    expect(appB).not.toBe(appA);
    expect(appA).not.toContain(input.targetingKey);
  });

  it("fails loud when rewrap cannot find a record", async () => {
    await expect(
      rewrapKvAppIdentityRecord({
        kv: memoryKv(),
        appId: "app_missing",
        oldRootSecret: ROOT,
        newRootSecret: NEXT_ROOT,
      }),
    ).rejects.toThrow(/no App identity record/);
  });

  it("mints on first advance of an App with no record", async () => {
    const identityStore = makeMemoryAppIdentityStore();
    const minted = await advanceAppIdentityEpoch(identityStore, "app_new");
    expect(minted.currentVersion).toBe("app-v1");
    expect(minted.epochs).toHaveLength(1);
  });
});
