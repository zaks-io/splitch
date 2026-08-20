/**
 * Shared TypeScript concatenation harness for Miniflare tests that load the
 * real App inventory + Entity outbox + assignment-store DO classes.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = dirname(fileURLToPath(import.meta.url));

export function bundleHoldoverWriteInventoryAndOutboxWorker(options?: {
  registerFailsRemaining?: number;
}): string {
  const registerFailsRemaining = options?.registerFailsRemaining ?? 0;
  const inventory = readSource("holdover-write-app-inventory.ts");
  const sagaStorage = stripImport(
    readSource("holdover-write-app-deletion-saga-storage.ts"),
    "./holdover-write-app-inventory",
  );
  const sagaCancel = stripImports(readSource("holdover-write-app-deletion-saga-cancel.ts"), [
    "./assignment-store",
    "./holdover-write-app-inventory",
    "./holdover-write-outbox-core",
    "./holdover-write-app-deletion-saga-storage",
  ]);
  const sagaFinalize = stripImports(readSource("holdover-write-app-deletion-saga-finalize.ts"), [
    "./holdover-write-app-inventory",
    "./holdover-write-app-deletion-saga-storage",
  ]);
  const saga = stripImports(readSource("holdover-write-app-deletion-saga.ts"), [
    "./assignment-store",
    "./holdover-write-app-inventory",
    "./holdover-write-outbox-core",
    "./holdover-write-app-deletion-saga-cancel",
    "./holdover-write-app-deletion-saga-finalize",
    "./holdover-write-app-deletion-saga-storage",
  ])
    .replace(/^export type \{[\s\S]*?\};?\s*/gm, "")
    .replace(/^export \{[\s\S]*?\};?\s*/gm, "");
  const inventoryFetch = stripIsRecordHelpers(
    stripImport(
      readSource("holdover-write-app-inventory-fetch.ts"),
      "./holdover-write-app-inventory",
    ),
  );
  const inventoryDo = stripImports(readSource("holdover-write-app-inventory-do.ts"), [
    "cloudflare:workers",
    "./assignment-store",
    "./holdover-write-app-inventory",
    "./holdover-write-app-inventory-fetch",
    "./holdover-write-app-deletion-saga",
    "./holdover-write-outbox",
    "./holdover-write-outbox-core",
  ]);
  const core = readSource("holdover-write-outbox-core.ts");
  const ensure = stripImports(readSource("holdover-write-outbox-ensure.ts"), [
    "./assignment-store",
    "./holdover-write-app-inventory",
    "./holdover-write-outbox-core",
  ]);
  const fetchHandler = stripIsRecordHelpers(
    stripImports(readSource("holdover-write-outbox-fetch.ts"), [
      "./assignment-store",
      "./holdover-write-app-inventory",
      "./holdover-write-app-inventory-client",
      "./holdover-write-outbox-core",
      "./holdover-write-outbox-ensure",
    ]),
  );
  const outbox = stripImports(readSource("holdover-write-outbox.ts"), [
    "./assignment-store",
    "./holdover-write-app-inventory",
    "./holdover-write-outbox-core",
    "./holdover-write-outbox-fetch",
    "./holdover-write-outbox-memory",
    "./kv-assignment-store",
  ])
    .replace(/^export \{[^}]*MemoryHoldoverWriteCoordinator[^}]*\} from [^;]+;?\s*/gm, "")
    .replace(/^export \{ handleHoldoverWriteOutboxFetch \} from [^;]+;?\s*/gm, "")
    .replace(/^export type \{[\s\S]*?\} from ["']\.\/holdover-write-outbox-core["'];?\s*/gm, "");
  const outboxDo = stripImports(readSource("holdover-write-outbox-do.ts"), [
    "cloudflare:workers",
    "./holdover-write-outbox",
    "./holdover-write-outbox-core",
    "./holdover-write-outbox-ensure",
    "./holdover-write-outbox-fetch",
  ]);
  const writer = stripImport(readSource("assignment-store-writer.ts"), "./assignment-store");
  const assignmentDo = stripIsRecordHelpers(
    stripImports(readSource("assignment-store-do.ts"), [
      "cloudflare:workers",
      "./assignment-store",
      "./assignment-store-writer",
    ]),
  );

  return ts.transpileModule(
    `
import { DurableObject } from "cloudflare:workers";
${inventoryClientStubs(registerFailsRemaining)}
${stripExport(inventory)}
${stripExport(sagaStorage)}
${stripExport(sagaCancel)}
${stripExport(sagaFinalize)}
${stripExport(saga)}
${stripExport(inventoryFetch)}
${inventoryDo}
${stripExport(core)}
${stripExport(ensure)}
${stripExport(fetchHandler)}
${stripExport(outbox)}
${outboxDo}
${stripExport(writer)}
${assignmentDo}
${registerFailHook(registerFailsRemaining)}
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
      fileName: "holdover-write-inventory-outbox.mf.ts",
    },
  ).outputText;
}

function inventoryClientStubs(registerFailsRemaining: number): string {
  const transportAware = registerFailsRemaining > 0;
  return `
globalThis.__registerFailsRemaining = ${String(registerFailsRemaining)};
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
class DurableHoldoverWriteAppInventoryClient {
  constructor(namespace) {
    this.namespace = namespace;
  }
  async registerEntity(appId, ref) {
    const stub = this.namespace.get(this.namespace.idFromName(appId));
    ${
      transportAware
        ? `let response;
    try {
      response = await stub.fetch("https://holdover-write-app-inventory.local/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ref),
      });
    } catch (cause) {
      throw new Error("app inventory transport failed", { cause });
    }
    if (!response.ok) {
      throw new Error("app inventory /register returned HTTP " + String(response.status));
    }
    const body = await response.json();
    if (body.status !== "registered" && body.status !== "suppressed") {
      throw new Error("register returned an invalid payload");
    }
    return { status: body.status };`
        : `const response = await stub.fetch("https://holdover-write-app-inventory.local/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ref),
    });
    if (!response.ok) throw new Error("register failed");
    return response.json();`
    }
  }
  async markEntityPurged(appId, ref) {
    const stub = this.namespace.get(this.namespace.idFromName(appId));
    const response = await stub.fetch(
      "https://holdover-write-app-inventory.local/mark-entity-purged",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ref),
      },
    );
    if (!response.ok) {
      throw new Error(${
        transportAware
          ? `"app inventory /mark-entity-purged returned HTTP " + String(response.status)`
          : `"mark-entity-purged failed"`
      });
    }
  }
}
function inventoryRegisterPortForApp(client, appId) {
  return {
    registerEntity: (ref) => client.registerEntity(appId, ref),
  };
}
`;
}

function registerFailHook(registerFailsRemaining: number): string {
  if (registerFailsRemaining <= 0) return "";
  return `
const __prodInventoryFetch = HoldoverWriteAppInventoryDurableObject.prototype.fetch;
HoldoverWriteAppInventoryDurableObject.prototype.fetch = async function (request) {
  const url = new URL(request.url);
  if (
    url.pathname === "/register" &&
    request.method === "POST" &&
    globalThis.__registerFailsRemaining > 0
  ) {
    globalThis.__registerFailsRemaining -= 1;
    throw new Error("forced register transport failure");
  }
  return __prodInventoryFetch.call(this, request);
};
`;
}

function readSource(name: string): string {
  return readFileSync(join(root, name), "utf8");
}

function stripImport(source: string, from: string): string {
  return source.replace(
    new RegExp(`^import[\\s\\S]*?from ["']${escapeRegExp(from)}["'];?\\s*`, "m"),
    "",
  );
}

function stripImports(source: string, froms: string[]): string {
  let next = source;
  for (const from of froms) next = stripImport(next, from);
  return next;
}

function stripIsRecordHelpers(source: string): string {
  return source.replace(
    /\nfunction isRecord\(value: unknown\): value is Record<string, unknown> \{[\s\S]*?\n\}\n\nfunction requireString\(value: Record<string, unknown>, key: string\): string \{[\s\S]*?\n\}\n/,
    "\n",
  );
}

function stripExport(source: string): string {
  return source.replace(/^export \{[\s\S]*?\};?\s*/gm, "").replace(/^export /gm, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
