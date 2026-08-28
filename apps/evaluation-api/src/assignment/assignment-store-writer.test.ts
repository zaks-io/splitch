import { assignmentKey } from "@splitch/contracts";
import { computeTargetingKeyHash, makeDerivedSaltStore } from "@splitch/privacy";
import { describe, expect, it } from "vitest";
import { serializeAssignmentValue } from "./assignment-store";
import {
  basePut,
  MapStorage,
  RAW_TARGETING_KEY,
  RecordingKv,
  StaticSaltStore,
} from "./assignment-store-test-fixtures";
import { AssignmentStoreWriter } from "./assignment-store-writer";
import { InMemoryAssignmentStore } from "./in-memory-assignment-store";

describe("InMemoryAssignmentStore", () => {
  it("serializes concurrent puts to the same assignment key to one winner", async () => {
    const store = new InMemoryAssignmentStore(new StaticSaltStore());

    const results = await Promise.all([
      store.put({ ...basePut, runId: "run-a", variant: "control" }),
      store.put({ ...basePut, runId: "run-b", variant: "treatment" }),
    ]);
    const holdovers = await store.getAll(basePut);

    expect(results.map((result) => result.status).sort()).toEqual(["existing", "stored"]);
    expect(holdovers.size).toBe(1);
    expect(["control", "treatment"]).toContain(holdovers.get("exp-checkout")?.variant);
    expect(store.entityKeyNames.join("|")).not.toContain(RAW_TARGETING_KEY);
    expect(store.writerObjectNames.join("|")).not.toContain(RAW_TARGETING_KEY);
    expect(store.policyCalls).toEqual([]);
  });

  it("makes a second put for an existing key a no-op", async () => {
    const store = new InMemoryAssignmentStore(new StaticSaltStore());

    await store.put(basePut);
    const second = await store.put({ ...basePut, runId: "run-2", variant: "treatment" });
    const holdovers = await store.getAll(basePut);

    expect(second).toEqual({
      status: "existing",
      assignment: { runId: "run-1", variant: "control" },
    });
    expect(holdovers.get("exp-checkout")).toEqual({ runId: "run-1", variant: "control" });
    expect(store.policyCalls).toEqual([]);
  });

  it("does not inspect runId or variant to decide whether a key exists", async () => {
    const store = new InMemoryAssignmentStore(new StaticSaltStore());

    await store.put(basePut);
    const second = await store.put({ ...basePut, runId: "run-new", variant: "treatment" });

    expect(second).toEqual({
      status: "existing",
      assignment: { runId: "run-1", variant: "control" },
    });
    expect(store.policyCalls).toEqual([]);
  });

  it("keeps a retained local-v1 holdover visible after the App identity epoch starts", async () => {
    const saltStore = makeDerivedSaltStore({ rootSecret: "test-root-secret-do-not-use" });
    const store = new InMemoryAssignmentStore(saltStore);
    const historicalHash = await computeTargetingKeyHash(saltStore, {
      appId: basePut.appId,
      idType: basePut.idType,
      targetingKey: basePut.targetingKey,
      keyVersion: "local-v1",
    });

    await store.putHashed({
      appId: basePut.appId,
      experimentId: "exp-checkout",
      idType: basePut.idType,
      targetingKeyHash: historicalHash,
      runId: "run-old",
      variant: "control",
    });
    const holdovers = await store.getAll(basePut);

    expect(holdovers).toEqual(
      new Map([["exp-checkout", { runId: "run-old", variant: "control" }]]),
    );
    expect(store.entityKeyNames.join("|")).not.toContain(RAW_TARGETING_KEY);
  });
});

describe("InMemoryAssignmentStore retained epochs", () => {
  it("returns current A plus retained B and writes new C only to the active epoch", async () => {
    const saltStore = makeDerivedSaltStore({ rootSecret: "test-root-secret-do-not-use" });
    const store = new InMemoryAssignmentStore(saltStore);
    const historicalHash = await computeTargetingKeyHash(saltStore, {
      appId: basePut.appId,
      idType: basePut.idType,
      targetingKey: basePut.targetingKey,
      keyVersion: "local-v1",
    });
    const currentHash = await computeTargetingKeyHash(saltStore, {
      appId: basePut.appId,
      idType: basePut.idType,
      targetingKey: basePut.targetingKey,
    });

    await store.putHashed({
      appId: basePut.appId,
      experimentId: "exp-retained",
      idType: basePut.idType,
      targetingKeyHash: historicalHash,
      runId: "run-old",
      variant: "control",
    });
    await store.putHashed({
      appId: basePut.appId,
      experimentId: "exp-current",
      idType: basePut.idType,
      targetingKeyHash: currentHash,
      runId: "run-now",
      variant: "treatment",
    });

    const holdovers = await store.getAll(basePut);
    expect(holdovers).toEqual(
      new Map([
        ["exp-retained", { runId: "run-old", variant: "control" }],
        ["exp-current", { runId: "run-now", variant: "treatment" }],
      ]),
    );

    const replayed = await store.put({
      ...basePut,
      experimentId: "exp-retained",
      runId: "run-should-not-win",
      variant: "treatment",
    });
    expect(replayed).toEqual({
      status: "existing",
      assignment: { runId: "run-old", variant: "control" },
    });

    const created = await store.put({
      ...basePut,
      experimentId: "exp-new",
      runId: "run-new",
      variant: "on",
    });
    expect(created).toEqual({
      status: "stored",
      assignment: { runId: "run-new", variant: "on" },
    });
    expect(store.entityKeyNames.at(-1)).toBe(
      assignmentKey(basePut.appId, basePut.idType, currentHash),
    );
    expect(store.writerObjectNames.at(-1)).toContain(currentHash);
  });

  it("fails loud when retained epoch maps conflict for one Experiment", async () => {
    const saltStore = makeDerivedSaltStore({ rootSecret: "test-root-secret-do-not-use" });
    const store = new InMemoryAssignmentStore(saltStore);
    const historicalHash = await computeTargetingKeyHash(saltStore, {
      appId: basePut.appId,
      idType: basePut.idType,
      targetingKey: basePut.targetingKey,
      keyVersion: "local-v1",
    });
    const currentHash = await computeTargetingKeyHash(saltStore, {
      appId: basePut.appId,
      idType: basePut.idType,
      targetingKey: basePut.targetingKey,
    });
    await store.putHashed({
      appId: basePut.appId,
      experimentId: "exp-checkout",
      idType: basePut.idType,
      targetingKeyHash: historicalHash,
      runId: "run-old",
      variant: "control",
    });
    await store.putHashed({
      appId: basePut.appId,
      experimentId: "exp-checkout",
      idType: basePut.idType,
      targetingKeyHash: currentHash,
      runId: "run-new",
      variant: "treatment",
    });
    await expect(store.getAll(basePut)).rejects.toThrow(
      /Conflicting Assignment for Experiment "exp-checkout"/,
    );
  });
});

describe("AssignmentStoreWriter", () => {
  it("write-through merges the stored winner into the Entity KV value before put returns", async () => {
    const kv = new RecordingKv();
    const writer = new AssignmentStoreWriter(new MapStorage(), kv, () => undefined);

    await expect(writer.put({ ...basePut, targetingKeyHash: "v1:hash-a" })).resolves.toMatchObject({
      status: "stored",
      assignment: { runId: "run-1", variant: "control" },
    });

    const raw = kv.raw(assignmentKey("app-A", "user", "v1:hash-a"));
    expect(raw).toBeDefined();
    expect(JSON.parse(raw as string).data).toEqual({
      "exp-checkout": { runId: "run-1", variant: "control" },
    });
  });

  it("keeps per-experiment winners under one per-entity writer", async () => {
    // The writer DO is per ENTITY; the same instance serializes first-touch
    // puts for different Experiments without clobbering the shared KV blob.
    const kv = new RecordingKv();
    const writer = new AssignmentStoreWriter(new MapStorage(), kv, () => undefined);

    await writer.put({ ...basePut, targetingKeyHash: "v1:hash-a" });
    await writer.put({
      ...basePut,
      targetingKeyHash: "v1:hash-a",
      experimentId: "exp-search",
      runId: "run-9",
      variant: "treatment",
    });

    expect(JSON.parse(kv.raw(assignmentKey("app-A", "user", "v1:hash-a")) as string).data).toEqual({
      "exp-checkout": { runId: "run-1", variant: "control" },
      "exp-search": { runId: "run-9", variant: "treatment" },
    });
  });

  it("fails the put when write-through fails, then re-asserts KV on the next put", async () => {
    const key = assignmentKey("app-A", "user", "v1:hash-a");
    const kv = new RecordingKv({ failPuts: true });
    const storage = new MapStorage();
    const writer = new AssignmentStoreWriter(storage, kv, () => undefined);

    // First put: DO storage commits, awaited KV write-through fails — put rejects
    // so callers (outbox) own retry instead of treating HTTP 200 as KV-complete.
    await expect(writer.put({ ...basePut, targetingKeyHash: "v1:hash-a" })).rejects.toThrow(
      "forced KV put failure",
    );
    expect(kv.raw(key)).toBeUndefined();
    expect(await storage.get("assignment:exp-checkout")).toMatchObject({
      targetingKeyHash: "v1:hash-a",
    });

    // Second put for the same assignment: still "existing", but the KV entry is
    // re-asserted so the holdover becomes visible to getAll.
    kv.failPuts = false;
    await expect(writer.put({ ...basePut, targetingKeyHash: "v1:hash-a" })).resolves.toMatchObject({
      status: "existing",
    });
    expect(JSON.parse(kv.raw(key) as string).data).toEqual({
      "exp-checkout": { runId: "run-1", variant: "control" },
    });
  });

  it("does not corrupt existing KV when awaited write-through fails", async () => {
    const key = assignmentKey("app-A", "user", "v1:hash-a");
    const kv = new RecordingKv({ failPuts: true }).putRaw(
      key,
      serializeAssignmentValue({ "exp-old": { runId: "run-old", variant: "old" } }),
    );
    const writer = new AssignmentStoreWriter(new MapStorage(), kv, () => undefined);

    await expect(writer.put({ ...basePut, targetingKeyHash: "v1:hash-a" })).rejects.toThrow(
      "forced KV put failure",
    );

    expect(JSON.parse(kv.raw(key) as string).data).toEqual({
      "exp-old": { runId: "run-old", variant: "old" },
    });
  });
});
