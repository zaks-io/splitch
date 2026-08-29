import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AssignmentStoreValueSchema } from "@splitch/contracts";
import { Miniflare } from "miniflare";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  AssignmentStoreError,
  hashedAssignmentIdentity,
  serializeAssignmentValue,
} from "./assignment-store";
import {
  basePut,
  RAW_TARGETING_KEY,
  RecordingAssignmentLogger,
  RecordingKv,
  RecordingWriterNamespace,
  StaticSaltStore,
} from "./assignment-store-test-fixtures";
import type { AssignmentWriterNamespace } from "./kv-assignment-store";
import { KvAssignmentStore } from "./kv-assignment-store";

function productionAssignmentStoreScript(): string {
  const root = dirname(fileURLToPath(import.meta.url));
  const writer = readFileSync(join(root, "assignment-store-writer.ts"), "utf8").replace(
    /^import[\s\S]*?from ["']\.\/assignment-store["'];?\s*/m,
    "",
  );
  const assignmentDo = readFileSync(join(root, "assignment-store-do.ts"), "utf8")
    .replace(/^import \{ DurableObject \} from "cloudflare:workers";\s*/m, "")
    .replace(/^import[\s\S]*?from ["']\.\/assignment-store["'];?\s*/m, "")
    .replace(/^import[\s\S]*?from ["']\.\/assignment-store-input["'];?\s*/m, "")
    .replace(/^import[\s\S]*?from ["']\.\/assignment-store-writer["'];?\s*/m, "");
  const assignmentInput = readFileSync(join(root, "assignment-store-input.ts"), "utf8")
    .replace(/^import[\s\S]*?from ["']\.\/assignment-store["'];?\s*/m, "")
    .replace(/^export /gm, "");
  const stubs = `
const CURRENT_KV_SCHEMA_VERSION = 1;
function assignmentKey(appId, idType, targetingKeyHash) {
  return "assignment:" + appId + ":" + idType + ":" + targetingKeyHash;
}
function mergeAssignmentValue(value, input) {
  if (value[input.experimentId] !== undefined) return value;
  return { ...value, [input.experimentId]: { runId: input.runId, variant: input.variant } };
}
function serializeAssignmentValue(value) {
  return JSON.stringify({ schemaVersion: CURRENT_KV_SCHEMA_VERSION, data: value });
}
async function readAssignmentValue(kv, key) {
  const raw = await kv.get(key);
  if (raw === null) return {};
  return JSON.parse(raw).data;
}
`;
  const stripExport = (source: string) =>
    source.replace(/^export \{[\s\S]*?\};?\s*/gm, "").replace(/^export /gm, "");
  return ts.transpileModule(
    `
import { DurableObject } from "cloudflare:workers";
${stubs}
${assignmentInput}
${stripExport(writer)}
${assignmentDo}
export default { async fetch() { return new Response("ok"); } };
`,
    {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        strict: true,
      },
      fileName: "assignment-store.mf.ts",
    },
  ).outputText;
}

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
    expect(namespace.names[0]).toContain("app-A:user:v1:");
    expect(namespace.names.join("|")).not.toContain(RAW_TARGETING_KEY);
    expect(JSON.stringify(namespace.bodies)).not.toContain(RAW_TARGETING_KEY);
  });

  it("serializes concurrent put calls through a Miniflare Durable Object", async () => {
    const mf = new Miniflare({
      modules: true,
      script: productionAssignmentStoreScript(),
      compatibilityDate: "2026-06-21",
      compatibilityFlags: ["nodejs_compat"],
      kvNamespaces: { ASSIGNMENTS_KV: "assignments" },
      durableObjects: {
        ASSIGNMENT_STORE_WRITER: { className: "AssignmentStoreDurableObjectV2" },
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
      const { entityKey } = await hashedAssignmentIdentity(new StaticSaltStore(), basePut);
      expect(await kv.get(entityKey)).toEqual(expect.any(String));
    } finally {
      await mf.dispose();
    }
  });
});

describe("KvAssignmentStore key isolation", () => {
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
