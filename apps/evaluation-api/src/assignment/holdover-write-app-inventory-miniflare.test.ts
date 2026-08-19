import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { DurableHoldoverWriteAppInventoryClient } from "./holdover-write-app-inventory-client";
import type { HoldoverWriteAppInventoryNamespace } from "./holdover-write-app-inventory";
import {
  DurableHoldoverWriteCoordinator,
  type HoldoverWriteOutboxNamespace,
} from "./holdover-write-outbox";

const PUT = {
  appId: "app-A",
  experimentId: "exp-checkout",
  idType: "user",
  targetingKeyHash: "hash-entity-1",
  runId: "run-42",
  variant: "treatment",
} as const;

describe("HoldoverWriteAppInventoryDurableObject via Miniflare", () => {
  let mf: Miniflare | undefined;

  afterEach(async () => {
    await mf?.dispose();
    mf = undefined;
  });

  it("retries App inventory registration after a transport failure until confirmed", async () => {
    mf = await miniflareWithInventoryAndOutbox({ registerFailsRemaining: 1 });
    const outboxNs = (await mf.getDurableObjectNamespace(
      "HOLDOVER_WRITE_OUTBOX",
    )) as unknown as HoldoverWriteOutboxNamespace;
    const inventoryNs = (await mf.getDurableObjectNamespace(
      "HOLDOVER_WRITE_APP_INVENTORY",
    )) as unknown as HoldoverWriteAppInventoryNamespace;
    const coordinator = new DurableHoldoverWriteCoordinator(outboxNs);
    const inventory = new DurableHoldoverWriteAppInventoryClient(inventoryNs);

    await expect(coordinator.ensure(PUT)).rejects.toThrow(/transport|register|failed|Error/i);
    expect((await inventory.status(PUT.appId)).entities).toEqual([]);

    await expect(coordinator.ensure(PUT)).resolves.toEqual({ status: "completed" });
    expect(await inventory.status(PUT.appId)).toMatchObject({
      suppressed: false,
      deletionComplete: false,
      entities: [{ idType: PUT.idType, targetingKeyHash: PUT.targetingKeyHash }],
    });
  });

  it("refuses registration once App deletion completes (register-versus-complete)", async () => {
    mf = await miniflareWithInventoryAndOutbox({ registerFailsRemaining: 0 });
    const inventoryNs = (await mf.getDurableObjectNamespace(
      "HOLDOVER_WRITE_APP_INVENTORY",
    )) as unknown as HoldoverWriteAppInventoryNamespace;
    const outboxNs = (await mf.getDurableObjectNamespace(
      "HOLDOVER_WRITE_OUTBOX",
    )) as unknown as HoldoverWriteOutboxNamespace;
    const inventory = new DurableHoldoverWriteAppInventoryClient(inventoryNs);
    const coordinator = new DurableHoldoverWriteCoordinator(outboxNs);

    await inventory.beginDeletion(PUT.appId, 9_000);
    await inventory.completeDeletion(PUT.appId);

    await expect(
      inventory.registerEntity(PUT.appId, {
        idType: PUT.idType,
        targetingKeyHash: PUT.targetingKeyHash,
      }),
    ).resolves.toEqual({ status: "suppressed" });
    await expect(coordinator.ensure(PUT)).resolves.toEqual({ status: "suppressed" });
    expect(await inventory.status(PUT.appId)).toMatchObject({
      suppressed: true,
      deletionComplete: true,
      entities: [],
    });
  });

  it("serializes register behind App deletion so complete cannot miss a late Entity", async () => {
    mf = await miniflareWithInventoryAndOutbox({ registerFailsRemaining: 0 });
    const inventoryNs = (await mf.getDurableObjectNamespace(
      "HOLDOVER_WRITE_APP_INVENTORY",
    )) as unknown as HoldoverWriteAppInventoryNamespace;
    const inventory = new DurableHoldoverWriteAppInventoryClient(inventoryNs);

    await inventory.beginDeletion(PUT.appId, 9_000);
    // Concurrent register + complete: DO blockConcurrencyWhile serializes them.
    // After suppress, register must return suppressed — never re-index post-complete.
    const [registerResult] = await Promise.all([
      inventory.registerEntity(PUT.appId, {
        idType: PUT.idType,
        targetingKeyHash: PUT.targetingKeyHash,
      }),
      inventory.completeDeletion(PUT.appId),
    ]);
    expect(registerResult).toEqual({ status: "suppressed" });
    expect(await inventory.status(PUT.appId)).toMatchObject({
      suppressed: true,
      deletionComplete: true,
      entities: [],
    });
  });
});

async function miniflareWithInventoryAndOutbox(options: {
  registerFailsRemaining: number;
}): Promise<Miniflare> {
  return new Miniflare({
    modules: true,
    script: bundleWorker(options.registerFailsRemaining),
    compatibilityDate: "2026-06-21",
    compatibilityFlags: ["nodejs_compat"],
    kvNamespaces: { ASSIGNMENTS_KV: "assignments" },
    durableObjects: {
      ASSIGNMENT_STORE_WRITER: { className: "AssignmentStoreDurableObject" },
      HOLDOVER_WRITE_OUTBOX: { className: "HoldoverWriteOutboxDurableObject" },
      HOLDOVER_WRITE_APP_INVENTORY: { className: "HoldoverWriteAppInventoryDurableObject" },
    },
  });
}

function bundleWorker(registerFailsRemaining: number): string {
  const root = dirname(fileURLToPath(import.meta.url));
  const inventory = readSource(join(root, "holdover-write-app-inventory.ts"));
  const inventoryFetch = readSource(join(root, "holdover-write-app-inventory-fetch.ts"))
    .replace(/^import[\s\S]*?from ["']\.\/holdover-write-app-inventory["'];?\s*/m, "")
    .replace(
      /\nfunction isRecord\(value: unknown\): value is Record<string, unknown> \{[\s\S]*?\n\}\n\nfunction requireString\(value: Record<string, unknown>, key: string\): string \{[\s\S]*?\n\}\n/,
      "\n",
    );
  const inventoryDo = readSource(join(root, "holdover-write-app-inventory-do.ts"))
    .replace(/^import \{ DurableObject \} from "cloudflare:workers";\s*/m, "")
    .replace(/^import[\s\S]*?from ["']\.\/assignment-store["'];?\s*/m, "")
    .replace(/^import[\s\S]*?from ["']\.\/holdover-write-app-inventory["'];?\s*/m, "")
    .replace(/^import[\s\S]*?from ["']\.\/holdover-write-app-inventory-fetch["'];?\s*/m, "")
    .replace(/^import[\s\S]*?from ["']\.\/holdover-write-outbox-core["'];?\s*/m, "");

  const core = readSource(join(root, "holdover-write-outbox-core.ts"));
  const ensure = readSource(join(root, "holdover-write-outbox-ensure.ts"))
    .replace(/^import[\s\S]*?from ["']\.\/assignment-store["'];?\s*/m, "")
    .replace(/^import[\s\S]*?from ["']\.\/holdover-write-app-inventory["'];?\s*/m, "")
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
    .replace(/^import[\s\S]*?from ["']\.\/holdover-write-app-inventory["'];?\s*/gm, "")
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
    let response;
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
    return { status: body.status };
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
${stripExport(inventory)}
${stripExport(inventoryFetch)}
${inventoryDo}
${stripExport(core)}
${stripExport(ensure)}
${stripExport(fetchHandler)}
${stripExport(outbox)}
${outboxDo}
${stripExport(writer)}
${assignmentDo}
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
      fileName: "holdover-write-app-inventory.mf.ts",
    },
  ).outputText;
}

function readSource(path: string): string {
  return readFileSync(path, "utf8");
}
