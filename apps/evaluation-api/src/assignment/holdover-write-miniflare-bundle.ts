/**
 * Shared TypeScript concatenation harness for Miniflare tests that load the
 * real App inventory + Entity outbox + assignment-store DO classes.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  holdoverWriteFaultHooks,
  holdoverWriteInventoryClientStubs,
} from "./holdover-write-miniflare-harness";

const root = dirname(fileURLToPath(import.meta.url));

export function bundleHoldoverWriteInventoryAndOutboxWorker(options?: {
  registerFailsRemaining?: number;
  suppressPutFailsRemaining?: number;
  cancelStatePutFailsRemaining?: number;
}): string {
  const registerFailsRemaining = options?.registerFailsRemaining ?? 0;
  const suppressPutFailsRemaining = options?.suppressPutFailsRemaining ?? 0;
  const cancelStatePutFailsRemaining = options?.cancelStatePutFailsRemaining ?? 0;
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
  ]);
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
${holdoverWriteInventoryClientStubs(
  registerFailsRemaining,
  suppressPutFailsRemaining,
  cancelStatePutFailsRemaining,
)}
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
${holdoverWriteFaultHooks(
  registerFailsRemaining,
  suppressPutFailsRemaining,
  cancelStatePutFailsRemaining,
)}
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
  // Drop barrel re-exports entirely (`export … { … } from "…"`), including
  // type-only forms. Leaving a dangling `from "…"` after stripping `export type`
  // becomes a runtime `from is not defined` in the Miniflare worker.
  return source
    .replace(/^export\s+type\s+\{[\s\S]*?\}\s+from\s+["'][^"']+["'];?\s*/gm, "")
    .replace(/^export\s+\{[\s\S]*?\}\s+from\s+["'][^"']+["'];?\s*/gm, "")
    .replace(/^export\s+type\s+\{[\s\S]*?\};?\s*/gm, "")
    .replace(/^export\s+\{[\s\S]*?\};?\s*/gm, "")
    .replace(/^export /gm, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
