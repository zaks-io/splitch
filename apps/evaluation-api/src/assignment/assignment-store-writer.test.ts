import { assignmentKey } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { serializeAssignmentValue } from "./assignment-store";
import { AssignmentStoreWriter } from "./assignment-store-writer";
import {
  basePut,
  MapStorage,
  RAW_TARGETING_KEY,
  RecordingKv,
  StaticSaltStore,
} from "./assignment-store-test-fixtures";
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
