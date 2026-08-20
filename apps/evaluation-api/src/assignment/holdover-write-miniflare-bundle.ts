/**
 * Shared TypeScript concatenation harness for Miniflare tests that load the
 * real App inventory + Entity outbox + assignment-store DO classes.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { holdoverWriteFaultHooks } from "./holdover-write-miniflare-faults";
import { holdoverWriteInventoryClientStubs } from "./holdover-write-miniflare-harness";

const root = dirname(fileURLToPath(import.meta.url));

interface HoldoverWriteMiniflareOptions {
  registerFailsRemaining?: number;
  suppressPutFailsRemaining?: number;
  cancelStatePutFailsRemaining?: number;
  cancelKvDeleteFailsRemaining?: number;
  staleSuppressionReadsRemaining?: number;
  writerPutFailsRemaining?: number;
  purgeFailsRemaining?: number;
  markTransactionFailsBeforeCommitRemaining?: number;
  markTransactionThrowsAfterCommitRemaining?: number;
  pauseCancelAfterKvDelete?: boolean;
  pauseFinalizeAfterInventoryList?: boolean;
  missingSuppressionReadsRemaining?: number;
}

const DEFAULT_OPTIONS = {
  registerFailsRemaining: 0,
  suppressPutFailsRemaining: 0,
  cancelStatePutFailsRemaining: 0,
  cancelKvDeleteFailsRemaining: 0,
  staleSuppressionReadsRemaining: 0,
  writerPutFailsRemaining: 0,
  purgeFailsRemaining: 0,
  markTransactionFailsBeforeCommitRemaining: 0,
  markTransactionThrowsAfterCommitRemaining: 0,
  pauseCancelAfterKvDelete: false,
  pauseFinalizeAfterInventoryList: false,
  missingSuppressionReadsRemaining: 0,
} satisfies Required<HoldoverWriteMiniflareOptions>;

export function bundleHoldoverWriteInventoryAndOutboxWorker(
  options?: HoldoverWriteMiniflareOptions,
): string {
  const source = renderWorkerSource(readWorkerSources(), { ...DEFAULT_OPTIONS, ...options });
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      strict: true,
    },
    fileName: "holdover-write-inventory-outbox.mf.ts",
  }).outputText;
}

function readWorkerSources() {
  return {
    inventory: readSource("holdover-write-app-inventory.ts"),
    deletionInput: readSource("holdover-write-app-deletion-input.ts"),
    sagaStorage: stripImport(
      readSource("holdover-write-app-deletion-saga-storage.ts"),
      "./holdover-write-app-inventory",
    ),
    sagaCancel: stripImports(readSource("holdover-write-app-deletion-saga-cancel.ts"), [
      "./assignment-store",
      "./holdover-write-app-inventory",
      "./holdover-write-outbox-core",
      "./holdover-write-app-deletion-saga-storage",
    ]),
    sagaFinalize: stripImports(readSource("holdover-write-app-deletion-saga-finalize.ts"), [
      "./holdover-write-app-inventory",
      "./holdover-write-app-deletion-saga-storage",
    ]),
    saga: stripImports(readSource("holdover-write-app-deletion-saga.ts"), [
      "./assignment-store",
      "./holdover-write-app-inventory",
      "./holdover-write-outbox-core",
      "./holdover-write-app-deletion-saga-cancel",
      "./holdover-write-app-deletion-saga-finalize",
      "./holdover-write-app-deletion-saga-storage",
    ]),
    inventoryFetch: stripIsRecordHelpers(
      stripImport(
        readSource("holdover-write-app-inventory-fetch.ts"),
        "./holdover-write-app-inventory",
      ),
    ),
    inventoryEntityPort: stripImports(readSource("holdover-write-app-inventory-entity-port.ts"), [
      "./holdover-write-outbox",
      "./holdover-write-app-deletion-saga-cancel",
      "./holdover-write-app-deletion-saga-finalize",
      "./holdover-write-outbox-core",
    ]),
    inventoryDo: stripImports(readSource("holdover-write-app-inventory-do.ts"), [
      "cloudflare:workers",
      "./assignment-store",
      "./holdover-write-app-inventory",
      "./holdover-write-app-inventory-fetch",
      "./holdover-write-app-deletion-input",
      "./holdover-write-app-deletion-saga",
      "./holdover-write-app-inventory-entity-port",
      "./holdover-write-outbox",
      "./holdover-write-outbox-core",
    ]),
    core: readSource("holdover-write-outbox-core.ts"),
    ensure: stripImports(readSource("holdover-write-outbox-ensure.ts"), [
      "./assignment-store",
      "./holdover-write-app-inventory",
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
      "./holdover-write-app-inventory",
      "./holdover-write-outbox-core",
      "./holdover-write-outbox-fetch",
      "./holdover-write-outbox-memory",
      "./kv-assignment-store",
    ])
      .replace(/^export \{[^}]*MemoryHoldoverWriteCoordinator[^}]*\} from [^;]+;?\s*/gm, "")
      .replace(/^export \{ handleHoldoverWriteOutboxFetch \} from [^;]+;?\s*/gm, "")
      .replace(/^export type \{[\s\S]*?\} from ["']\.\/holdover-write-outbox-core["'];?\s*/gm, ""),
    outboxDo: stripImports(readSource("holdover-write-outbox-do.ts"), [
      "cloudflare:workers",
      "./holdover-write-outbox",
      "./holdover-write-outbox-core",
      "./holdover-write-outbox-ensure",
      "./holdover-write-outbox-fetch",
    ]),
    writer: stripImport(readSource("assignment-store-writer.ts"), "./assignment-store"),
    assignmentDo: stripIsRecordHelpers(
      stripImports(readSource("assignment-store-do.ts"), [
        "cloudflare:workers",
        "./assignment-store",
        "./assignment-store-writer",
      ]),
    ),
  };
}

function renderWorkerSource(
  sources: ReturnType<typeof readWorkerSources>,
  options: Required<HoldoverWriteMiniflareOptions>,
): string {
  const {
    inventory,
    deletionInput,
    sagaStorage,
    sagaCancel,
    sagaFinalize,
    saga,
    inventoryFetch,
    inventoryEntityPort,
    inventoryDo,
    core,
    ensure,
    fetchHandler,
    outbox,
    outboxDo,
    writer,
    assignmentDo,
  } = sources;
  const {
    registerFailsRemaining,
    suppressPutFailsRemaining,
    cancelStatePutFailsRemaining,
    cancelKvDeleteFailsRemaining,
    staleSuppressionReadsRemaining,
    writerPutFailsRemaining,
    purgeFailsRemaining,
    markTransactionFailsBeforeCommitRemaining,
    markTransactionThrowsAfterCommitRemaining,
    pauseCancelAfterKvDelete,
    pauseFinalizeAfterInventoryList,
    missingSuppressionReadsRemaining,
  } = options;
  return `
import { DurableObject } from "cloudflare:workers";
${holdoverWriteInventoryClientStubs(
  registerFailsRemaining,
  suppressPutFailsRemaining,
  cancelStatePutFailsRemaining,
  cancelKvDeleteFailsRemaining,
  staleSuppressionReadsRemaining,
  writerPutFailsRemaining,
  purgeFailsRemaining,
  markTransactionFailsBeforeCommitRemaining,
  markTransactionThrowsAfterCommitRemaining,
  pauseCancelAfterKvDelete,
  pauseFinalizeAfterInventoryList,
  missingSuppressionReadsRemaining,
)}
${stripExport(inventory)}
${stripExport(deletionInput)}
${stripExport(sagaStorage)}
${stripExport(sagaCancel)}
${stripExport(sagaFinalize)}
${stripExport(saga)}
${stripExport(inventoryFetch)}
${stripExport(inventoryEntityPort)}
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
  cancelKvDeleteFailsRemaining,
  staleSuppressionReadsRemaining,
  writerPutFailsRemaining,
  purgeFailsRemaining,
  markTransactionFailsBeforeCommitRemaining,
  markTransactionThrowsAfterCommitRemaining,
  pauseCancelAfterKvDelete,
  pauseFinalizeAfterInventoryList,
  missingSuppressionReadsRemaining,
)}
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__test/deadlock-barrier-status") {
      return Response.json({
        cancelKvDeleteReached: globalThis.__cancelKvDeleteReached,
        ensureRegisterAttempts: globalThis.__ensureRegisterAttempts,
        finalizeInventoryListReached: globalThis.__finalizeInventoryListReached,
      });
    }
    if (url.pathname === "/__test/release-cancel-kv-delete" && request.method === "POST") {
      globalThis.__releaseCancelKvDelete?.();
      return Response.json({ released: true });
    }
    if (url.pathname === "/__test/release-finalize-inventory-list" && request.method === "POST") {
      globalThis.__releaseFinalizeInventoryList?.();
      return Response.json({ released: true });
    }
    return new Response("harness", { status: 200 });
  },
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
