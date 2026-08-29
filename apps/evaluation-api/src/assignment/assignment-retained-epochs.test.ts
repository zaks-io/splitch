import { assignmentKey } from "@splitch/contracts";
import { computeTargetingKeyHash, makeMemoryAppIdentityStore } from "@splitch/privacy";
import { describe, expect, it } from "vitest";
import { makeEnvSaltStore } from "../local-salt-store";
import {
  hashedAssignmentIdentity,
  mergeRetainedAssignmentValues,
  serializeAssignmentValue,
} from "./assignment-store";
import { basePut, RecordingKv, RecordingWriterNamespace } from "./assignment-store-test-fixtures";
import { KvAssignmentStore } from "./kv-assignment-store";

describe("KvAssignmentStore retained-epoch merge", () => {
  it("keeps a retained local-v1 holdover visible after the App identity epoch starts", async () => {
    const saltStore = makeEnvSaltStore({
      EVALUATION_PRIVACY_SALT: "test-root-secret-do-not-use",
      SPLITCH_PLATFORM_TARGET: "production",
      identityStore: makeMemoryAppIdentityStore(),
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

  it("fails loud when retained epochs disagree on one Experiment", () => {
    expect(() =>
      mergeRetainedAssignmentValues([
        { "exp-checkout": { runId: "run-old", variant: "control" } },
        { "exp-checkout": { runId: "run-new", variant: "treatment" } },
      ]),
    ).toThrow(/Conflicting Assignment for Experiment "exp-checkout"/);
  });

  it("replays a retained Experiment and writes a genuinely new Experiment to the active epoch", async () => {
    const saltStore = makeEnvSaltStore({
      EVALUATION_PRIVACY_SALT: "test-root-secret-do-not-use",
      SPLITCH_PLATFORM_TARGET: "production",
      identityStore: makeMemoryAppIdentityStore(),
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

    await expect(store.put(basePut)).resolves.toEqual({
      status: "existing",
      assignment: { runId: "run-old", variant: "control" },
    });
    expect(namespace.names).toEqual([]);

    const created = await store.put({ ...basePut, experimentId: "exp-search" });
    expect(created).toEqual({
      status: "stored",
      assignment: { runId: "run-new", variant: "treatment" },
    });
    expect(namespace.names).toHaveLength(1);
    expect(namespace.names[0]).toContain("app-v1:");
    expect(namespace.names[0]).not.toContain("local-v1:");
  });
});
