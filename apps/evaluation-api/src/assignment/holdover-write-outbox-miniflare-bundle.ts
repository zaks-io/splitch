import ts from "typescript";
import {
  readSource,
  stripExport,
  stripImports,
  stripIsRecordHelpers,
} from "./holdover-write-miniflare-source";

export function bundleOutboxAssignmentWorker(failFirstKvPut: boolean): string {
  const sources = readWorkerSources();
  return ts.transpileModule(renderWorker(sources, failFirstKvPut), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      strict: true,
    },
    fileName: "holdover-write-outbox.mf.ts",
  }).outputText;
}

function readWorkerSources() {
  return {
    core: readSource("holdover-write-outbox-core.ts"),
    ensure: stripImports(readSource("holdover-write-outbox-ensure.ts"), [
      "./assignment-store",
      "./holdover-write-outbox-core",
    ]),
    fetchHandler: stripIsRecordHelpers(
      stripImports(readSource("holdover-write-outbox-fetch.ts"), [
        "./assignment-store",
        "./holdover-write-app-inventory",
        "./holdover-write-app-inventory-client",
        "./holdover-write-outbox-core",
        "./holdover-write-outbox-ensure",
      ]),
    ),
    outbox: stripImports(readSource("holdover-write-outbox.ts"), [
      "./assignment-store",
      "./holdover-write-outbox-core",
      "./holdover-write-app-inventory-client",
      "./holdover-write-outbox-fetch",
      "./holdover-write-outbox-memory",
      "./kv-assignment-store",
    ]),
    outboxDo: stripImports(readSource("holdover-write-outbox-do.ts"), [
      "cloudflare:workers",
      "./holdover-write-outbox",
      "./holdover-write-outbox-core",
      "./holdover-write-outbox-ensure",
      "./holdover-write-outbox-fetch",
    ]),
    writer: stripImports(readSource("assignment-store-writer.ts"), ["./assignment-store"]),
    assignmentDo: stripIsRecordHelpers(
      stripImports(readSource("assignment-store-do.ts"), [
        "cloudflare:workers",
        "./assignment-store",
        "./assignment-store-input",
        "./assignment-store-writer",
      ]),
    ),
    assignmentInput: stripIsRecordHelpers(
      stripImports(readSource("assignment-store-input.ts"), ["./assignment-store"]),
    ),
  };
}

function renderWorker(
  sources: ReturnType<typeof readWorkerSources>,
  failFirstKvPut: boolean,
): string {
  return `
import { DurableObject } from "cloudflare:workers";
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
  constructor(namespace) { this.namespace = namespace; }
  registerEntity() { return Promise.resolve({ status: "registered" }); }
  async putAssignment(input) {
    const stub = this.namespace.get(this.namespace.idFromName(input.appId));
    const response = await stub.fetch("https://inventory.local/put-assignment", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error("test inventory put failed");
    return response.json();
  }
}
function inventoryRegisterPortForApp(client, appId) {
  return { registerEntity: (ref) => client.registerEntity(appId, ref) };
}
${stripExport(sources.assignmentInput)}
${stripExport(sources.core)}
${stripExport(sources.ensure)}
${stripExport(sources.fetchHandler)}
${stripExport(sources.outbox)}
${sources.outboxDo}
${stripExport(sources.writer)}
${sources.assignmentDo}
export class TestAppInventoryDurableObject extends DurableObject {
  async fetch(request) {
    const input = await request.json();
    const writers = this.env.ASSIGNMENT_STORE_WRITER;
    return writers.get(writers.idFromName(assignmentWriterName(input))).fetch(
      "https://assignment-store.local/put",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) },
    );
  }
}
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
const __prodAssignmentFetch = AssignmentStoreDurableObjectV2.prototype.fetch;
AssignmentStoreDurableObjectV2.prototype.fetch = async function (request) {
  const originalKv = this.env.ASSIGNMENTS_KV;
  this.env.ASSIGNMENTS_KV = failOnceKv(originalKv);
  try {
    return await __prodAssignmentFetch.call(this, request);
  } finally {
    this.env.ASSIGNMENTS_KV = originalKv;
  }
};
export default { async fetch() { return new Response("harness"); } };
`;
}
