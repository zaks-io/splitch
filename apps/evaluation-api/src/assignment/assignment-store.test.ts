import { Miniflare } from "miniflare";
import { describe, expect, it } from "vitest";
import {
  AssignmentStoreError,
  hashedAssignmentIdentity,
  serializeAssignmentValue,
} from "./assignment-store.js";
import {
  basePut,
  RAW_TARGETING_KEY,
  RecordingKv,
  RecordingWriterNamespace,
  StaticSaltStore,
} from "./assignment-store-test-fixtures.js";
import { KvAssignmentStore } from "./kv-assignment-store.js";

describe("KvAssignmentStore", () => {
  it("getAll returns all holdovers in one KV read and touches no DO", async () => {
    const saltStore = new StaticSaltStore();
    const kv = new RecordingKv();
    const namespace = new RecordingWriterNamespace();
    const { entityKey } = await hashedAssignmentIdentity(saltStore, basePut);
    kv.putRaw(
      entityKey,
      serializeAssignmentValue({
        "exp-checkout": { runId: "run-1", variant: "control" },
        "exp-search": { runId: "run-9", variant: "treatment" },
      }),
    );

    const store = new KvAssignmentStore(kv, namespace, saltStore);
    const holdovers = await store.getAll(basePut);

    expect([...holdovers.entries()]).toEqual([
      ["exp-checkout", { runId: "run-1", variant: "control" }],
      ["exp-search", { runId: "run-9", variant: "treatment" }],
    ]);
    expect(kv.getCalls).toEqual([entityKey]);
    expect(namespace.names).toEqual([]);
  });

  it("reads the envelope through a Miniflare local KV namespace", async () => {
    const mf = new Miniflare({
      modules: true,
      script: "export default {};",
      kvNamespaces: { ASSIGNMENTS_KV: "assignments" },
    });
    try {
      const saltStore = new StaticSaltStore();
      const kv = (await mf.getKVNamespace("ASSIGNMENTS_KV")) as unknown as KVNamespace;
      const { entityKey } = await hashedAssignmentIdentity(saltStore, basePut);
      await kv.put(
        entityKey,
        serializeAssignmentValue({ "exp-checkout": { runId: "run-1", variant: "control" } }),
      );

      const store = new KvAssignmentStore(kv, new RecordingWriterNamespace(), saltStore);
      await expect(store.getAll(basePut)).resolves.toEqual(
        new Map([["exp-checkout", { runId: "run-1", variant: "control" }]]),
      );
    } finally {
      await mf.dispose();
    }
  });

  it("put routes to a hashed per-assignment DO name without exposing the raw Targeting Key", async () => {
    const saltStore = new StaticSaltStore();
    const namespace = new RecordingWriterNamespace({
      status: "stored",
      assignment: { runId: "run-1", variant: "control" },
    });
    const store = new KvAssignmentStore(new RecordingKv(), namespace, saltStore);

    await expect(store.put(basePut)).resolves.toEqual({
      status: "stored",
      assignment: { runId: "run-1", variant: "control" },
    });

    expect(namespace.names).toHaveLength(1);
    expect(namespace.names[0]).toContain("app-A:exp-checkout:user:v1:");
    expect(namespace.names.join("|")).not.toContain(RAW_TARGETING_KEY);
    expect(JSON.stringify(namespace.bodies)).not.toContain(RAW_TARGETING_KEY);
  });

  it("does not let App B read App A's Entity assignment key", async () => {
    const saltStore = new StaticSaltStore();
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
    expect(kv.getCalls).toEqual([appB.entityKey]);
    expect(appB.entityKey).not.toBe(appA.entityKey);
  });

  it("fails loud when a KV entry carries per-entry schemaVersion", async () => {
    const saltStore = new StaticSaltStore();
    const kv = new RecordingKv();
    const { entityKey } = await hashedAssignmentIdentity(saltStore, basePut);
    kv.putRaw(
      entityKey,
      JSON.stringify({
        schemaVersion: 1,
        data: { "exp-checkout": { runId: "run-1", variant: "control", schemaVersion: 1 } },
      }),
    );

    const store = new KvAssignmentStore(kv, new RecordingWriterNamespace(), saltStore);

    await expect(store.getAll(basePut)).rejects.toBeInstanceOf(AssignmentStoreError);
  });

  it("raw Targeting Key is absent from every KV key and DO name the store builds", async () => {
    const saltStore = new StaticSaltStore();
    const kv = new RecordingKv();
    const namespace = new RecordingWriterNamespace();
    const store = new KvAssignmentStore(kv, namespace, saltStore);

    await store.put(basePut);
    await store.getAll(basePut);

    const names = [...kv.getCalls, ...namespace.names].join("|");
    expect(names).not.toContain(RAW_TARGETING_KEY);
  });
});
