import { describe, expect, it } from "vitest";
import { makeInProcessAppIdentityExclusive } from "./app-identity-exclusive";
import {
  deriveAppIdentityKek,
  generateAppIdentityKey,
  nextAppIdentityVersion,
  unwrapAppIdentityKey,
  wrapAppIdentityKey,
} from "./app-identity-key";
import {
  defaultAppEntityIdentityRecordKey,
  parseWrappedAppIdentityRecord,
} from "./app-identity-record";
import {
  makeKvAppIdentityStore,
  makeMemoryAppIdentityStore,
  mintInitialAppIdentityRecord,
  provisionAppIdentity,
  rewrapKvAppIdentityRecord,
} from "./app-identity-store";
import { makeIdentitySaltStore } from "./derived-salt-store";
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

  it("keeps local-v1, v1, app-v1, and current lookup hashes stable across root rewrap", async () => {
    const kv = memoryKv();
    const firstStore = makeKvAppIdentityStore({ kv, rootSecret: ROOT });
    const first = makeIdentitySaltStore({ rootSecret: ROOT, identityStore: firstStore });
    const beforeCurrent = await computeTargetingKeyHash(first, input);
    const beforeLocal = await computeTargetingKeyHash(first, { ...input, keyVersion: "local-v1" });
    const beforeV1 = await computeTargetingKeyHash(first, { ...input, keyVersion: "v1" });
    const beforeApp = await computeTargetingKeyHash(first, { ...input, keyVersion: "app-v1" });

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
    expect(await computeTargetingKeyHash(rotated, input)).toBe(beforeCurrent);
    expect(await computeTargetingKeyHash(rotated, { ...input, keyVersion: "local-v1" })).toBe(
      beforeLocal,
    );
    expect(await computeTargetingKeyHash(rotated, { ...input, keyVersion: "v1" })).toBe(beforeV1);
    expect(await computeTargetingKeyHash(rotated, { ...input, keyVersion: "app-v1" })).toBe(
      beforeApp,
    );
    expect(kv.raw(defaultAppEntityIdentityRecordKey(input.appId))).toEqual(expect.any(String));
  });

  it("returns one canonical epoch when Evaluation and Event Ingest provision concurrently", async () => {
    const kv = memoryKv();
    const exclusive = makeInProcessAppIdentityExclusive();
    const evaluation = makeKvAppIdentityStore({ kv, rootSecret: ROOT, exclusive });
    const ingest = makeKvAppIdentityStore({ kv, rootSecret: ROOT, exclusive });
    const [left, right] = await Promise.all([
      provisionAppIdentity(evaluation, input.appId, ROOT),
      provisionAppIdentity(ingest, input.appId, ROOT),
    ]);
    const leftActive = left.epochs.find((epoch) => epoch.role === "active")?.key;
    const rightActive = right.epochs.find((epoch) => epoch.role === "active")?.key;
    expect(leftActive).toBeDefined();
    expect(rightActive).toBeDefined();
    if (leftActive === undefined || rightActive === undefined) {
      throw new Error("provisioned App identity record is missing its active epoch");
    }
    expect(toHex(leftActive)).toBe(toHex(rightActive));
    expect(left.currentVersion).toBe("app-v1");
    expect(right.currentVersion).toBe("app-v1");
    expect(kv.raw(defaultAppEntityIdentityRecordKey(input.appId))).toEqual(expect.any(String));
  });

  it("does not activate a later mint over an already-provisioned record", async () => {
    const kv = memoryKv();
    const store = makeKvAppIdentityStore({ kv, rootSecret: ROOT });
    const first = mintInitialAppIdentityRecord(ROOT);
    const second = mintInitialAppIdentityRecord(ROOT);
    const firstActive = first.epochs.find((epoch) => epoch.role === "active")?.key;
    const secondActive = second.epochs.find((epoch) => epoch.role === "active")?.key;
    expect(firstActive).toBeDefined();
    expect(secondActive).toBeDefined();
    if (firstActive === undefined || secondActive === undefined) {
      throw new Error("minted App identity record is missing its active epoch");
    }
    expect(toHex(firstActive)).not.toBe(toHex(secondActive));
    await store.save(input.appId, first);
    const winner = await store.putIfAbsent(input.appId, second);
    const loadedActive = winner.epochs.find((epoch) => epoch.role === "active")?.key;
    expect(loadedActive).toBeDefined();
    if (loadedActive === undefined) {
      throw new Error("stored App identity record is missing its active epoch");
    }
    expect(toHex(loadedActive)).toBe(toHex(firstActive));
  });

  it("rejects legacy, incomplete, and unknown nested hosted record fields", async () => {
    const kv = memoryKv();
    const store = makeKvAppIdentityStore({ kv, rootSecret: ROOT });
    await provisionAppIdentity(store, input.appId, ROOT);
    const raw = kv.raw(defaultAppEntityIdentityRecordKey(input.appId));
    if (raw === undefined) throw new Error("wrapped fixture was not persisted");
    const record = JSON.parse(raw) as Record<string, unknown>;

    expect(() =>
      parseWrappedAppIdentityRecord(JSON.stringify({ ...record, schemaVersion: 1 })),
    ).toThrow(/invalid App identity record/);
    const missingLifecycle = { ...record };
    delete missingLifecycle.lifecycle;
    expect(() => parseWrappedAppIdentityRecord(JSON.stringify(missingLifecycle))).toThrow(
      /invalid App identity record/,
    );
    const epochs = record.epochs as Record<string, unknown>[];
    expect(() =>
      parseWrappedAppIdentityRecord(
        JSON.stringify({
          ...record,
          epochs: [{ ...epochs[0], unexpected: true }, ...epochs.slice(1)],
        }),
      ),
    ).toThrow(/invalid App identity record/);
    expect(() =>
      parseWrappedAppIdentityRecord(
        JSON.stringify({
          ...record,
          lifecycle: { ...(record.lifecycle as Record<string, unknown>), unexpected: true },
        }),
      ),
    ).toThrow(/invalid App identity record/);
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
});
