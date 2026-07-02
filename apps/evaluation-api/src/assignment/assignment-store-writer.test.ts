import { assignmentKey } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { serializeAssignmentValue } from "./assignment-store.js";
import { AssignmentStoreWriter } from "./assignment-store-writer.js";
import {
  basePut,
  MapStorage,
  RAW_TARGETING_KEY,
  RecordingKv,
  StaticSaltStore,
} from "./assignment-store-test-fixtures.js";
import { InMemoryAssignmentStore } from "./in-memory-assignment-store.js";

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
  });
});

describe("AssignmentStoreWriter", () => {
  it("write-through merges the stored winner into the Entity KV value", async () => {
    const kv = new RecordingKv();
    const waits: Promise<unknown>[] = [];
    const writer = new AssignmentStoreWriter(new MapStorage(), kv, (promise) =>
      waits.push(promise),
    );

    await expect(writer.put({ ...basePut, targetingKeyHash: "v1:hash-a" })).resolves.toMatchObject({
      status: "stored",
      assignment: { runId: "run-1", variant: "control" },
    });
    await Promise.all(waits);

    const raw = kv.raw(assignmentKey("app-A", "user", "v1:hash-a"));
    expect(raw).toBeDefined();
    expect(JSON.parse(raw as string).data).toEqual({
      "exp-checkout": { runId: "run-1", variant: "control" },
    });
  });

  it("does not corrupt existing KV when fire-and-forget write-through fails", async () => {
    const key = assignmentKey("app-A", "user", "v1:hash-a");
    const kv = new RecordingKv({ failPuts: true }).putRaw(
      key,
      serializeAssignmentValue({ "exp-old": { runId: "run-old", variant: "old" } }),
    );
    const waits: Promise<unknown>[] = [];
    const writer = new AssignmentStoreWriter(new MapStorage(), kv, (promise) =>
      waits.push(promise),
    );

    await expect(writer.put({ ...basePut, targetingKeyHash: "v1:hash-a" })).resolves.toMatchObject({
      status: "stored",
    });
    await expect(Promise.all(waits)).rejects.toThrow("forced KV put failure");

    expect(JSON.parse(kv.raw(key) as string).data).toEqual({
      "exp-old": { runId: "run-old", variant: "old" },
    });
  });
});
