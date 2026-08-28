import { describe, expect, it } from "vitest";
import { makeInProcessAppIdentityExclusive } from "./app-identity-exclusive";
import {
  deriveAppIdentityKek,
  generateAppIdentityKey,
  nextAppIdentityVersion,
  unwrapAppIdentityKey,
  wrapAppIdentityKey,
} from "./app-identity-key";
import { defaultAppEntityIdentityRecordKey } from "./app-identity-record";
import {
  APP_IDENTITY_RESET_CHECKPOINTS,
  type AppIdentityResetAttestation,
  resetAppIdentityAfterCheckpoints,
} from "./app-identity-reset";
import {
  activateCompromisedAppIdentityEpoch,
  advanceAppIdentityEpoch,
  beginCompromisedAppIdentityRotation,
  makeKvAppIdentityStore,
  makeMemoryAppIdentityStore,
  mintInitialAppIdentityRecord,
  provisionAppIdentity,
  recordAppIdentityLifecycleCheckpoint,
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

  it("refuses to advance an unprovisioned App", async () => {
    const identityStore = makeMemoryAppIdentityStore();
    await expect(advanceAppIdentityEpoch(identityStore, "app_new")).rejects.toThrow(
      /unprovisioned/,
    );
  });

  it("cannot activate a compromised rotation before every checkpoint", async () => {
    const identityStore = makeMemoryAppIdentityStore();
    await provisionAppIdentity(identityStore, input.appId, ROOT);
    await beginCompromisedAppIdentityRotation(identityStore, input.appId);
    await expect(activateCompromisedAppIdentityEpoch(identityStore, input.appId)).rejects.toThrow(
      /cannot activate before/,
    );
    await recordAppIdentityLifecycleCheckpoint(identityStore, input.appId, {
      runsEnded: true,
      clientKeysRevoked: true,
      purge: {
        assignments: true,
        analytics: true,
        idempotency: true,
        export: true,
      },
    });
    await expect(activateCompromisedAppIdentityEpoch(identityStore, input.appId)).rejects.toThrow(
      /deletion purge checkpoint/,
    );
    await recordAppIdentityLifecycleCheckpoint(identityStore, input.appId, {
      purge: { deletion: true },
    });
    const activated = await activateCompromisedAppIdentityEpoch(identityStore, input.appId);
    expect(activated.currentVersion).toBe("app-v2");
    expect(activated.lifecycle.state).toBe("active");
  });
});

function resetAttestation(): AppIdentityResetAttestation {
  return Object.fromEntries(
    APP_IDENTITY_RESET_CHECKPOINTS.map((checkpoint) => [checkpoint, true]),
  ) as AppIdentityResetAttestation;
}

describe("App identity compromised reset", () => {
  const input = { appId: "app_1", idType: "user", targetingKey: "user-123" } as const;

  it("refuses to replace the live key without ADR-0044 checkpoints", async () => {
    const identityStore = makeMemoryAppIdentityStore();
    await provisionAppIdentity(identityStore, input.appId, ROOT);
    const incomplete = resetAttestation();
    delete (incomplete as { verify_purge_checkpoints?: true }).verify_purge_checkpoints;
    await expect(
      resetAppIdentityAfterCheckpoints(identityStore, input.appId, incomplete),
    ).rejects.toThrow(/ADR-0044 checkpoints/);
  });

  it("replaces the live key only after every destructive checkpoint", async () => {
    const identityStore = makeMemoryAppIdentityStore();
    const saltStore = makeIdentitySaltStore({ rootSecret: ROOT, identityStore });
    const before = await computeTargetingKeyHash(saltStore, input);
    const replaced = await resetAppIdentityAfterCheckpoints(
      identityStore,
      input.appId,
      resetAttestation(),
    );
    expect(replaced.currentVersion).toBe("app-v2");
    expect(replaced.epochs).toHaveLength(1);
    expect(await computeTargetingKeyHash(saltStore, input)).not.toBe(before);
    await expect(saltStore.saltFor(input.appId, "app-v1")).rejects.toThrow(/unknown salt version/);
  });
});
