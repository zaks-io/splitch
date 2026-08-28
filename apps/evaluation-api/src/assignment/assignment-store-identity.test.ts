import { assignmentKey } from "@splitch/contracts";
import {
  computeTargetingKeyHash,
  makeIdentitySaltStore,
  makeMemoryAppIdentityStore,
  mintInitialAppIdentityRecord,
} from "@splitch/privacy";
import { describe, expect, it } from "vitest";
import { makeEnvSaltStore } from "../local-salt-store";
import { hashedAssignmentIdentity, serializeAssignmentValue } from "./assignment-store";
import {
  basePut,
  RAW_TARGETING_KEY,
  RecordingKv,
  RecordingWriterNamespace,
} from "./assignment-store-test-fixtures";
import { KvAssignmentStore } from "./kv-assignment-store";

function hostedIdentitySaltStore() {
  return makeEnvSaltStore({
    EVALUATION_PRIVACY_SALT: "test-root-secret-do-not-use",
    SPLITCH_PLATFORM_TARGET: "production",
    identityStore: makeMemoryAppIdentityStore(),
  });
}

describe("KvAssignmentStore first-mint identity merge", () => {
  it("keeps a first-mint holdover visible after a later mint is merged", async () => {
    const identityStore = makeMemoryAppIdentityStore();
    const first = mintInitialAppIdentityRecord();
    await identityStore.save(basePut.appId, first, { merge: false });
    const saltStore = makeIdentitySaltStore({
      rootSecret: "test-root-secret-do-not-use",
      identityStore,
    });
    const firstHash = await computeTargetingKeyHash(saltStore, {
      appId: basePut.appId,
      idType: basePut.idType,
      targetingKey: basePut.targetingKey,
    });
    const firstKey = assignmentKey(basePut.appId, basePut.idType, firstHash);
    const kv = new RecordingKv();
    kv.putRaw(
      firstKey,
      serializeAssignmentValue({ "exp-checkout": { runId: "run-first", variant: "control" } }),
    );
    await identityStore.save(basePut.appId, mintInitialAppIdentityRecord());

    const store = new KvAssignmentStore(kv, new RecordingWriterNamespace(), saltStore);
    const holdovers = await store.getAll(basePut);

    expect(firstHash.startsWith("app-v1:")).toBe(true);
    expect(holdovers).toEqual(
      new Map([["exp-checkout", { runId: "run-first", variant: "control" }]]),
    );
    expect(kv.getCalls).toContain(firstKey);
  });

  it("isolates two Apps that share one Evaluation privacy root secret", async () => {
    const saltStore = hostedIdentitySaltStore();
    const kv = new RecordingKv();
    const appA = await hashedAssignmentIdentity(saltStore, basePut);
    kv.putRaw(
      appA.entityKey,
      serializeAssignmentValue({ "exp-checkout": { runId: "run-1", variant: "control" } }),
    );

    const store = new KvAssignmentStore(kv, new RecordingWriterNamespace(), saltStore);
    const appBHoldovers = await store.getAll({ ...basePut, appId: "app-B" });
    const appB = await hashedAssignmentIdentity(saltStore, { ...basePut, appId: "app-B" });

    expect(appBHoldovers.size).toBe(0);
    expect(kv.getCalls.every((key) => key.startsWith("assignment:app-B:"))).toBe(true);
    expect(kv.getCalls).not.toContain(appA.entityKey);
    expect(appB.entityKey).not.toBe(appA.entityKey);
    expect(appA.targetingKeyHash).not.toBe(appB.targetingKeyHash);
    expect(appA.targetingKeyHash).not.toContain(RAW_TARGETING_KEY);
  });

  it("keeps a retained local-v1 holdover visible after the App identity epoch starts", async () => {
    const saltStore = hostedIdentitySaltStore();
    const historicalHash = await computeTargetingKeyHash(saltStore, {
      appId: basePut.appId,
      idType: basePut.idType,
      targetingKey: basePut.targetingKey,
      keyVersion: "local-v1",
    });
    const historicalKey = assignmentKey(basePut.appId, basePut.idType, historicalHash);
    const kv = new RecordingKv();
    kv.putRaw(
      historicalKey,
      serializeAssignmentValue({ "exp-checkout": { runId: "run-old", variant: "control" } }),
    );

    const store = new KvAssignmentStore(kv, new RecordingWriterNamespace(), saltStore);
    const current = await hashedAssignmentIdentity(saltStore, basePut);
    const holdovers = await store.getAll(basePut);

    expect(historicalHash.startsWith("local-v1:")).toBe(true);
    expect(current.targetingKeyHash.startsWith("app-v1:")).toBe(true);
    expect(current.targetingKeyHash).not.toBe(historicalHash);
    expect(current.entityKey).not.toBe(historicalKey);
    expect(holdovers).toEqual(
      new Map([["exp-checkout", { runId: "run-old", variant: "control" }]]),
    );
    expect(kv.getCalls).toContain(historicalKey);
    expect(kv.getCalls).toContain(current.entityKey);
  });
});
