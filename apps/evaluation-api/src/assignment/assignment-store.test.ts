import { AssignmentStoreValueSchema } from "@splitch/contracts";
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
  RecordingAssignmentLogger,
  RecordingKv,
  RecordingWriterNamespace,
  StaticSaltStore,
} from "./assignment-store-test-fixtures.js";
import type { AssignmentWriterNamespace } from "./kv-assignment-store.js";
import { KvAssignmentStore } from "./kv-assignment-store.js";

const MINIFLARE_ASSIGNMENT_STORE_DO = `
import { DurableObject } from "cloudflare:workers";

const STORAGE_KEY = "assignment";
const CURRENT_KV_SCHEMA_VERSION = 1;

export class AssignmentStoreDurableObject extends DurableObject {
  async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/put") {
      return Response.json({ error: "not found" }, { status: 404 });
    }

    const input = await request.json();
    const result = await this.ctx.blockConcurrencyWhile(async () => {
      const existing = await this.ctx.storage.get(STORAGE_KEY);
      if (existing !== undefined) {
        return { status: "existing", assignment: entryFrom(existing) };
      }

      await this.ctx.storage.put(STORAGE_KEY, input);
      this.ctx.waitUntil(writeThrough(this.env.ASSIGNMENTS_KV, input));
      return { status: "stored", assignment: entryFrom(input) };
    });
    return Response.json(result);
  }
}

async function writeThrough(kv, input) {
  const key = assignmentKey(input.appId, input.idType, input.targetingKeyHash);
  const raw = await kv.get(key);
  const current = raw === null ? {} : JSON.parse(raw).data;
  const next =
    current[input.experimentId] === undefined
      ? { ...current, [input.experimentId]: entryFrom(input) }
      : current;
  await kv.put(key, JSON.stringify({ schemaVersion: CURRENT_KV_SCHEMA_VERSION, data: next }));
}

function assignmentKey(appId, idType, targetingKeyHash) {
  return \`assignment:\${appId}:\${idType}:\${targetingKeyHash}\`;
}

function entryFrom(input) {
  return { runId: input.runId, variant: input.variant };
}
`;

describe("KvAssignmentStore", () => {
  it("getAll returns an empty map for a never-seen Entity", async () => {
    const store = new KvAssignmentStore(
      new RecordingKv(),
      new RecordingWriterNamespace(),
      new StaticSaltStore(),
    );

    const holdovers = await store.getAll(basePut);

    expect(holdovers).toEqual(new Map());
  });

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
});

describe("KvAssignmentStore.put", () => {
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

  it("serializes concurrent put calls through a Miniflare Durable Object", async () => {
    const mf = new Miniflare({
      modules: true,
      script: MINIFLARE_ASSIGNMENT_STORE_DO,
      compatibilityDate: "2026-06-21",
      compatibilityFlags: ["nodejs_compat"],
      kvNamespaces: { ASSIGNMENTS_KV: "assignments" },
      durableObjects: {
        ASSIGNMENT_STORE_WRITER: { className: "AssignmentStoreDurableObject" },
      },
    });

    try {
      const kv = (await mf.getKVNamespace("ASSIGNMENTS_KV")) as unknown as KVNamespace;
      const namespace = (await mf.getDurableObjectNamespace(
        "ASSIGNMENT_STORE_WRITER",
      )) as unknown as AssignmentWriterNamespace;
      const store = new KvAssignmentStore(kv, namespace, new StaticSaltStore());

      const results = await Promise.all([
        store.put({ ...basePut, runId: "run-a", variant: "control" }),
        store.put({ ...basePut, runId: "run-b", variant: "treatment" }),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual(["existing", "stored"]);
      expect(new Set(results.map((result) => result.assignment.runId)).size).toBe(1);
    } finally {
      await mf.dispose();
    }
  });
});

describe("KvAssignmentStore isolation and validation", () => {
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

  it("fails loud and logs when a KV entry carries per-entry schemaVersion", async () => {
    const saltStore = new StaticSaltStore();
    const kv = new RecordingKv();
    const logger = new RecordingAssignmentLogger();
    const { entityKey } = await hashedAssignmentIdentity(saltStore, basePut);
    kv.putRaw(
      entityKey,
      JSON.stringify({
        schemaVersion: 1,
        data: { "exp-checkout": { runId: "run-1", variant: "control", schemaVersion: 1 } },
      }),
    );

    const store = new KvAssignmentStore(kv, new RecordingWriterNamespace(), saltStore, logger);

    await expect(store.getAll(basePut)).rejects.toMatchObject({
      name: AssignmentStoreError.name,
      errorCode: "INTERNAL_SERVER_ERROR",
    });
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]).toMatchObject({
      message: "assignment_store_kv_parse_failed",
      detail: { key: entityKey },
    });
  });

  it("AssignmentStoreValue Zod parse rejects a malformed blob", () => {
    expect(
      AssignmentStoreValueSchema.safeParse({
        "exp-checkout": { runId: "run-1", variant: 42 },
      }).success,
    ).toBe(false);
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
