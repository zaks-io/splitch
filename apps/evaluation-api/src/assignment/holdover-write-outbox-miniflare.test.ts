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
 * Miniflare boundary: real HoldoverWriteOutbox DO + production
 * `AssignmentStoreWriter` / `AssignmentStoreDurableObject` sources. Injects a
 * first KV put failure so completion cannot mean "DO HTTP 200 while KV is still
 * pending in waitUntil".
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

  it("completed ensure means KV is already visible (HTTP 200 cannot precede KV)", async () => {
    mf = await miniflareWithOutboxAndAssignmentStore({ failFirstKvPut: false });
    const outboxNs = (await mf.getDurableObjectNamespace(
      "HOLDOVER_WRITE_OUTBOX",
    )) as unknown as HoldoverWriteOutboxNamespace;
    const coordinator = new DurableHoldoverWriteCoordinator(outboxNs);
    await expect(coordinator.ensure(PUT)).resolves.toEqual({ status: "completed" });
    const key = assignmentKey(PUT.appId, PUT.idType, PUT.targetingKeyHash);
    const kv = await mf.getKVNamespace("ASSIGNMENTS_KV");
    // Production AssignmentStoreWriter awaits write-through before HTTP 200.
    // A waitUntil regression would ack completed while this get is still null.
    expect(await kv.get(key)).toEqual(expect.any(String));
  });

  it("retains a real alarm for post-cutoff pending work and eventually runs it", async () => {
    mf = await miniflareWithOutboxAndAssignmentStore({ failFirstKvPut: true });
    const outboxNs = (await mf.getDurableObjectNamespace(
      "HOLDOVER_WRITE_OUTBOX",
    )) as unknown as HoldoverWriteOutboxNamespace;
    const coordinator = new DurableHoldoverWriteCoordinator(outboxNs);
    await expect(coordinator.ensure(PUT, { sourceCreatedAtMs: 10_000 })).resolves.toEqual({
      status: "owned",
    });
    const stub = outboxNs.get(outboxNs.idFromName(holdoverWriteOutboxName(PUT)));

    await coordinator.purgeEntity(PUT, 9_999);

    const alarmState = await stub.fetch("https://holdover-write-outbox.local/__test/alarm-state");
    const { alarm } = (await alarmState.json()) as { alarm: number | null };
    expect(alarm).toEqual(expect.any(Number));
    expect(await (await stub.fetch("https://holdover-write-outbox.local/status")).json()).toEqual({
      jobs: [expect.objectContaining({ experimentId: PUT.experimentId, status: "pending" })],
    });

    await stub.fetch("https://holdover-write-outbox.local/__test/alarm", { method: "POST" });

    expect(await (await stub.fetch("https://holdover-write-outbox.local/status")).json()).toEqual({
      status: "empty",
    });
    const key = assignmentKey(PUT.appId, PUT.idType, PUT.targetingKeyHash);
    expect(await (await mf.getKVNamespace("ASSIGNMENTS_KV")).get(key)).toEqual(expect.any(String));
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
  const ensure = readSource(join(root, "holdover-write-outbox-ensure.ts"))
    .replace(/^import[\s\S]*?from ["']\.\/assignment-store["'];?\s*/m, "")
    .replace(/^import[\s\S]*?from ["']\.\/holdover-write-outbox-core["'];?\s*/m, "");
  const fetchHandler = readSource(join(root, "holdover-write-outbox-fetch.ts"))
    .replace(/^import[\s\S]*?from ["']\.\/assignment-store["'];?\s*/m, "")
    .replace(/^import[\s\S]*?from ["']\.\/holdover-write-app-inventory["'];?\s*/m, "")
    .replace(/^import[\s\S]*?from ["']\.\/holdover-write-app-inventory-client["'];?\s*/m, "")
    .replace(/^import[\s\S]*?from ["']\.\/holdover-write-outbox-core["'];?\s*/m, "")
    .replace(/^import[\s\S]*?from ["']\.\/holdover-write-outbox-ensure["'];?\s*/m, "")
    .replace(
      /\nfunction isRecord\(value: unknown\): value is Record<string, unknown> \{[\s\S]*?\n\}\n\nfunction requireString\(value: Record<string, unknown>, key: string\): string \{[\s\S]*?\n\}\n/,
      "\n",
    );
  const outbox = readSource(join(root, "holdover-write-outbox.ts"))
    .replace(/^import[\s\S]*?from ["']\.\/assignment-store["'];?\s*/gm, "")
    .replace(/^import[\s\S]*?from ["']\.\/holdover-write-outbox-core["'];?\s*/gm, "")
    .replace(/^import[\s\S]*?from ["']\.\/holdover-write-outbox-fetch["'];?\s*/gm, "")
    .replace(/^import[\s\S]*?from ["']\.\/holdover-write-outbox-memory["'];?\s*/gm, "")
    .replace(/^import[\s\S]*?from ["']\.\/kv-assignment-store["'];?\s*/gm, "")
    .replace(/^export \{[^}]*MemoryHoldoverWriteCoordinator[^}]*\} from [^;]+;?\s*/gm, "")
    .replace(/^export \{ handleHoldoverWriteOutboxFetch \} from [^;]+;?\s*/gm, "")
    .replace(/^export type \{[\s\S]*?\} from ["']\.\/holdover-write-outbox-core["'];?\s*/gm, "");
  const outboxDo = readSource(join(root, "holdover-write-outbox-do.ts"))
    .replace(/^import \{ DurableObject \} from "cloudflare:workers";\s*/m, "")
    .replace(/^import[\s\S]*?from ["']\.\/holdover-write-outbox["'];?\s*/m, "")
    .replace(/^import[\s\S]*?from ["']\.\/holdover-write-outbox-core["'];?\s*/m, "")
    .replace(/^import[\s\S]*?from ["']\.\/holdover-write-outbox-ensure["'];?\s*/m, "")
    .replace(/^import[\s\S]*?from ["']\.\/holdover-write-outbox-fetch["'];?\s*/m, "");

  // Production writer + DO (not an inlined twin). Contracts/Zod are stubbed;
  // write-through helpers match the production assignment-store module.
  const writer = readSource(join(root, "assignment-store-writer.ts")).replace(
    /^import[\s\S]*?from ["']\.\/assignment-store["'];?\s*/m,
    "",
  );
  const assignmentDo = readSource(join(root, "assignment-store-do.ts"))
    .replace(/^import \{ DurableObject \} from "cloudflare:workers";\s*/m, "")
    .replace(/^import[\s\S]*?from ["']\.\/assignment-store["'];?\s*/m, "")
    .replace(/^import[\s\S]*?from ["']\.\/assignment-store-writer["'];?\s*/m, "")
    .replace(
      /\nfunction isRecord\(value: unknown\): value is Record<string, unknown> \{[\s\S]*?\n\}\n\nfunction requireString\(value: Record<string, unknown>, key: string\): string \{[\s\S]*?\n\}\n/,
      "\n",
    );

  const stubs = `
globalThis.__holdoverKvFailsRemaining = ${failFirstKvPut ? "1" : "0"};
const CURRENT_KV_SCHEMA_VERSION = 1;
function assignmentWriterName(input) {
  return input.appId + ":" + input.idType + ":" + input.targetingKeyHash;
}
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
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireString(value, key) {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new TypeError("assignment-store: " + key + " must be a non-empty string");
  }
  return field;
}
function failOnceKv(kv) {
  return {
    get: (key) => kv.get(key),
    put: async (key, value) => {
      if (${failFirstKvPut ? "true" : "false"} && globalThis.__holdoverKvFailsRemaining > 0) {
        globalThis.__holdoverKvFailsRemaining -= 1;
        throw new Error("forced KV put failure");
      }
      return kv.put(key, value);
    },
  };
}
class DurableHoldoverWriteAppInventoryClient {
  constructor() {}
  registerEntity() {
    return Promise.resolve({ status: "registered" });
  }
}
function inventoryRegisterPortForApp(client, appId) {
  return {
    registerEntity: (ref) => client.registerEntity(appId, ref),
  };
}
`;

  const stripExport = (source: string) =>
    source.replace(/^export \{[\s\S]*?\};?\s*/gm, "").replace(/^export /gm, "");

  return ts.transpileModule(
    `
import { DurableObject } from "cloudflare:workers";
${stubs}
${stripExport(core)}
${stripExport(ensure)}
${stripExport(fetchHandler)}
${stripExport(outbox)}
${outboxDo}
${stripExport(writer)}
${assignmentDo}
const __prodOutboxFetch = HoldoverWriteOutboxDurableObject.prototype.fetch;
HoldoverWriteOutboxDurableObject.prototype.fetch = async function (request) {
  const url = new URL(request.url);
  if (url.pathname === "/__test/alarm-state") {
    return Response.json({ alarm: await this.ctx.storage.getAlarm() });
  }
  if (url.pathname === "/__test/alarm" && request.method === "POST") {
    const scheduledAt = await this.ctx.storage.getAlarm();
    const originalDateNow = Date.now;
    if (scheduledAt !== null) Date.now = () => scheduledAt;
    try {
      await this.alarm();
      return Response.json({ ok: true });
    } finally {
      Date.now = originalDateNow;
    }
  }
  return __prodOutboxFetch.call(this, request);
};
const __prodAssignmentFetch = AssignmentStoreDurableObject.prototype.fetch;
AssignmentStoreDurableObject.prototype.fetch = async function (request) {
  const originalKv = this.env.ASSIGNMENTS_KV;
  this.env.ASSIGNMENTS_KV = failOnceKv(originalKv);
  try {
    return await __prodAssignmentFetch.call(this, request);
  } finally {
    this.env.ASSIGNMENTS_KV = originalKv;
  }
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
