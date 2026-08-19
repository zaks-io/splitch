import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assignmentKey } from "@splitch/contracts";
import { Miniflare } from "miniflare";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import {
  DurableHoldoverWriteCoordinator,
  type HoldoverWriteOutboxNamespace,
} from "./holdover-write-outbox";
import { holdoverWriteOutboxName } from "./holdover-write-outbox-core";

/**
 * Miniflare boundary: real HoldoverWriteOutbox DO + production Assignment Store
 * writer semantics (awaited KV write-through). Injects a first KV put failure so
 * completion cannot mean "DO HTTP 200 while KV is still pending in waitUntil".
 */

const PUT = {
  appId: "app-A",
  experimentId: "exp-checkout",
  idType: "user",
  targetingKeyHash: "hash-entity-1",
  runId: "run-42",
  variant: "treatment",
} as const;

describe("HoldoverWriteOutboxDurableObject via Miniflare (real boundary)", () => {
  let mf: Miniflare | undefined;

  afterEach(async () => {
    await mf?.dispose();
    mf = undefined;
  });

  it("owns retry after first KV write-through failure and becomes readable after alarm", async () => {
    mf = await miniflareWithOutboxAndAssignmentStore({ failFirstKvPut: true });
    const outboxNs = (await mf.getDurableObjectNamespace(
      "HOLDOVER_WRITE_OUTBOX",
    )) as unknown as HoldoverWriteOutboxNamespace;
    const coordinator = new DurableHoldoverWriteCoordinator(outboxNs);

    const first = await coordinator.ensure(PUT);
    expect(first).toEqual({ status: "owned" });

    const key = assignmentKey(PUT.appId, PUT.idType, PUT.targetingKeyHash);
    const kvBefore = await mf.getKVNamespace("ASSIGNMENTS_KV");
    expect(await kvBefore.get(key)).toBeNull();

    const stub = outboxNs.get(outboxNs.idFromName(holdoverWriteOutboxName(PUT)));
    const alarm = await stub.fetch("https://holdover-write-outbox.local/__test/alarm", {
      method: "POST",
    });
    expect(alarm.status).toBe(200);

    const status = await stub.fetch("https://holdover-write-outbox.local/status");
    expect(await status.json()).toEqual({ status: "empty" });

    const kvAfter = await mf.getKVNamespace("ASSIGNMENTS_KV");
    const raw = await kvAfter.get(key);
    expect(raw).toEqual(expect.any(String));
    expect(JSON.parse(raw as string)).toMatchObject({
      data: {
        [PUT.experimentId]: { runId: PUT.runId, variant: PUT.variant },
      },
    });
  });

  it("duplicate ensure after completion does not leave durable job rows", async () => {
    mf = await miniflareWithOutboxAndAssignmentStore({ failFirstKvPut: false });
    const outboxNs = (await mf.getDurableObjectNamespace(
      "HOLDOVER_WRITE_OUTBOX",
    )) as unknown as HoldoverWriteOutboxNamespace;
    const coordinator = new DurableHoldoverWriteCoordinator(outboxNs);
    await expect(coordinator.ensure(PUT)).resolves.toEqual({ status: "completed" });
    await expect(coordinator.ensure(PUT)).resolves.toEqual({ status: "completed" });
    const stub = outboxNs.get(outboxNs.idFromName(holdoverWriteOutboxName(PUT)));
    expect(await (await stub.fetch("https://holdover-write-outbox.local/status")).json()).toEqual({
      status: "empty",
    });
  });
});

async function miniflareWithOutboxAndAssignmentStore(options: {
  failFirstKvPut: boolean;
}): Promise<Miniflare> {
  return new Miniflare({
    modules: true,
    script: bundleWorker(options.failFirstKvPut),
    compatibilityDate: "2026-06-21",
    compatibilityFlags: ["nodejs_compat"],
    kvNamespaces: { ASSIGNMENTS_KV: "assignments" },
    durableObjects: {
      ASSIGNMENT_STORE_WRITER: { className: "AssignmentStoreDurableObject" },
      HOLDOVER_WRITE_OUTBOX: { className: "HoldoverWriteOutboxDurableObject" },
    },
  });
}

function bundleWorker(failFirstKvPut: boolean): string {
  const root = dirname(fileURLToPath(import.meta.url));
  const core = readSource(join(root, "holdover-write-outbox-core.ts"));
  const outbox = readSource(join(root, "holdover-write-outbox.ts"))
    .replace(/^import[\s\S]*?from ["']\.\/assignment-store["'];?\s*/gm, "")
    .replace(/^import[\s\S]*?from ["']\.\/holdover-write-outbox-core["'];?\s*/gm, "")
    .replace(/^import[\s\S]*?from ["']\.\/kv-assignment-store["'];?\s*/gm, "");
  const doClass = readSource(join(root, "holdover-write-outbox-do.ts"))
    .replace(/^import \{ DurableObject \} from "cloudflare:workers";\s*/m, "")
    .replace(/^import[\s\S]*?from ["']\.\/holdover-write-outbox["'];?\s*/m, "")
    .replace(/^import[\s\S]*?from ["']\.\/holdover-write-outbox-core["'];?\s*/m, "");

  // Production Assignment Store writer + DO, with optional first-KV-failure injection.
  const assignmentDo = `
const STORAGE_KEY_PREFIX = "assignment:";
const CURRENT_KV_SCHEMA_VERSION = 1;

class AssignmentStoreWriter {
  constructor(storage, kv, _waitUntil) {
    this.storage = storage;
    this.kv = kv;
  }
  async put(input) {
    const storageKey = STORAGE_KEY_PREFIX + input.experimentId;
    const existing = await this.storage.get(storageKey);
    if (existing !== undefined) {
      await this.writeThrough(existing);
      return { status: "existing", assignment: entryFrom(existing) };
    }
    await this.storage.put(storageKey, input);
    await this.writeThrough(input);
    return { status: "stored", assignment: entryFrom(input) };
  }
  async writeThrough(input) {
    const key = assignmentKey(input.appId, input.idType, input.targetingKeyHash);
    const current = await readAssignmentValue(this.kv, key);
    const next = mergeAssignmentValue(current, input);
    if (next === current) return;
    await this.kv.put(key, JSON.stringify({ schemaVersion: CURRENT_KV_SCHEMA_VERSION, data: next }));
  }
}

function assignmentKey(appId, idType, targetingKeyHash) {
  return "assignment:" + appId + ":" + idType + ":" + targetingKeyHash;
}
function entryFrom(input) {
  return { runId: input.runId, variant: input.variant };
}
function mergeAssignmentValue(value, input) {
  if (value[input.experimentId] !== undefined) return value;
  return { ...value, [input.experimentId]: entryFrom(input) };
}
async function readAssignmentValue(kv, key) {
  const raw = await kv.get(key);
  if (raw === null) return {};
  return JSON.parse(raw).data;
}

function failOnceKv(kv) {
  return {
    get: (key) => kv.get(key),
    put: async (key, value) => {
      // Module-level gate: DO storage must not be the fail-once ledger — a thrown
      // writeThrough after storage.put can leave test harnesses ambiguous about
      // whether the gate row persisted before the HTTP 503.
      if (${failFirstKvPut ? "true" : "false"} && globalThis.__holdoverKvFailsRemaining > 0) {
        globalThis.__holdoverKvFailsRemaining -= 1;
        throw new Error("forced KV put failure");
      }
      return kv.put(key, value);
    },
  };
}

export class AssignmentStoreDurableObject extends DurableObject {
  async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/put") {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const input = await request.json();
    try {
      const result = await this.ctx.blockConcurrencyWhile(() =>
        new AssignmentStoreWriter(
          this.ctx.storage,
          failOnceKv(this.env.ASSIGNMENTS_KV),
          (promise) => this.ctx.waitUntil(promise),
        ).put(input),
      );
      return Response.json(result);
    } catch (cause) {
      return new Response(cause instanceof Error ? cause.message : String(cause), { status: 503 });
    }
  }
}
`;

  const stubs = `
globalThis.__holdoverKvFailsRemaining = ${failFirstKvPut ? "1" : "0"};
function assignmentWriterName(input) {
  return input.appId + ":" + input.idType + ":" + input.targetingKeyHash;
}
`;

  const stripExport = (source: string) =>
    source.replace(/^export \{[\s\S]*?\};?\s*/gm, "").replace(/^export /gm, "");

  return ts.transpileModule(
    `
import { DurableObject } from "cloudflare:workers";
${stubs}
${stripExport(core)}
${stripExport(outbox)}
${doClass}
${assignmentDo}
const __prodFetch = HoldoverWriteOutboxDurableObject.prototype.fetch;
HoldoverWriteOutboxDurableObject.prototype.fetch = async function (request) {
  const url = new URL(request.url);
  if (url.pathname === "/__test/alarm" && request.method === "POST") {
    await this.alarm();
    return Response.json({ ok: true });
  }
  return __prodFetch.call(this, request);
};
export default {
  async fetch() {
    return new Response("harness", { status: 200 });
  },
};
`,
    {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        strict: true,
      },
      fileName: "holdover-write-outbox.mf.ts",
    },
  ).outputText;
}

function readSource(path: string): string {
  return readFileSync(path, "utf8");
}
