import { assignmentKey } from "@splitch/contracts";
import {
  computeTargetingKeyHash,
  makeMemoryIdentityKeyPersist,
  makePersistedIdentitySaltStore,
  mintAppIdentityEpoch,
} from "@splitch/privacy";
import { describe, expect, it } from "vitest";
import { hashedAssignmentIdentity, serializeAssignmentValue } from "./assignment-store";
import {
  basePut,
  RAW_TARGETING_KEY,
  RecordingKv,
  RecordingWriterNamespace,
} from "./assignment-store-test-fixtures";
import { KvAssignmentStore } from "./kv-assignment-store";

const ROOT = "test-root-secret-do-not-use";

describe("KvAssignmentStore identity epochs", () => {
  it("isolates two Apps after each App identity key is minted", async () => {
    const persist = makeMemoryIdentityKeyPersist();
    await mintAppIdentityEpoch({
      persist,
      appId: basePut.appId,
      kekMaterial: ROOT,
      epochId: "epoch-a",
    });
    await mintAppIdentityEpoch({
      persist,
      appId: "app-B",
      kekMaterial: ROOT,
      epochId: "epoch-b",
    });
    const saltStore = makePersistedIdentitySaltStore({
      persist,
      rootSecret: ROOT,
      currentKeyVersion: "local-v1",
    });
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
    expect(appB.entityKey).not.toBe(appA.entityKey);
    expect(appA.targetingKeyHash).not.toBe(appB.targetingKeyHash);
    expect(appA.targetingKeyHash.startsWith("epoch-a:")).toBe(true);
    expect(appB.targetingKeyHash.startsWith("epoch-b:")).toBe(true);
    expect(appA.targetingKeyHash).not.toContain(RAW_TARGETING_KEY);
  });

  it("keeps a retained local-v1 holdover visible after the App identity key is minted", async () => {
    const persist = makeMemoryIdentityKeyPersist();
    await mintAppIdentityEpoch({
      persist,
      appId: basePut.appId,
      kekMaterial: ROOT,
      epochId: "epoch-2",
    });
    const saltStore = makePersistedIdentitySaltStore({
      persist,
      rootSecret: ROOT,
      currentKeyVersion: "local-v1",
    });
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

    const namespace = new RecordingWriterNamespace({
      status: "stored",
      assignment: { runId: "run-new", variant: "treatment" },
    });
    const store = new KvAssignmentStore(kv, namespace, saltStore);
    const current = await hashedAssignmentIdentity(saltStore, basePut);
    const holdovers = await store.getAll(basePut);
    await store.put({
      ...basePut,
      experimentId: "exp-search",
      runId: "run-new",
      variant: "treatment",
    });

    expect(historicalHash.startsWith("local-v1:")).toBe(true);
    expect(current.targetingKeyHash.startsWith("epoch-2:")).toBe(true);
    expect(current.targetingKeyHash).not.toBe(historicalHash);
    expect(current.entityKey).not.toBe(historicalKey);
    expect(holdovers).toEqual(
      new Map([["exp-checkout", { runId: "run-old", variant: "control" }]]),
    );
    expect(kv.getCalls).toContain(historicalKey);
    expect(namespace.names[0]).toContain(historicalHash);
    expect(namespace.names.join("|")).not.toContain(current.targetingKeyHash);
  });
});
