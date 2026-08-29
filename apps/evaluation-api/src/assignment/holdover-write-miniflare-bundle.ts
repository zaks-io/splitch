/**
 * Shared TypeScript concatenation harness for Miniflare tests that load the
 * real App inventory + Entity outbox + assignment-store DO classes.
 */
import ts from "typescript";
import { holdoverWriteFaultHooks } from "./holdover-write-miniflare-faults";
import { holdoverWriteInventoryClientStubs } from "./holdover-write-miniflare-harness";
import {
  type HoldoverWriteMiniflareOptions,
  resolveHoldoverWriteMiniflareOptions,
} from "./holdover-write-miniflare-options";
import {
  readSource,
  stripExport,
  stripImport,
  stripImports,
  stripIsRecordHelpers,
} from "./holdover-write-miniflare-source";

export function bundleHoldoverWriteInventoryAndOutboxWorker(
  options?: HoldoverWriteMiniflareOptions,
): string {
  const source = renderWorkerSource(
    readWorkerSources(),
    resolveHoldoverWriteMiniflareOptions(options),
  );
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
      "./holdover-write-app-inventory-client",
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
    identityReset: stripImports(readSource("holdover-write-app-identity-reset.ts"), [
      "./holdover-write-app-deletion-input",
      "./holdover-write-app-deletion-saga",
      "./holdover-write-app-inventory",
    ]),
    assignmentInput: stripIsRecordHelpers(
      stripImport(readSource("assignment-store-input.ts"), "./assignment-store"),
    ),
    appAssignment: stripImports(readSource("holdover-write-app-assignment.ts"), [
      "@splitch/privacy",
      "./assignment-store",
      "./assignment-store-input",
      "./holdover-write-app-inventory",
      "./kv-assignment-store",
    ]),
    inventoryDo: stripImports(readSource("holdover-write-app-inventory-do.ts"), [
      "cloudflare:workers",
      "./assignment-store",
      "./holdover-write-app-assignment",
      "./holdover-write-app-inventory",
      "./holdover-write-app-identity-reset",
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
      "./holdover-write-outbox-binding",
    ]),
    writer: stripImport(readSource("assignment-store-writer.ts"), "./assignment-store"),
    assignmentDo: stripIsRecordHelpers(
      stripImports(readSource("assignment-store-do.ts"), [
        "cloudflare:workers",
        "./assignment-store",
        "./assignment-store-input",
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
    identityReset,
    assignmentInput,
    appAssignment,
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
    pauseCancelAlarmAfterSnapshot,
    pausePreparedAlarmAfterSnapshot,
    pauseAssignmentWriterPut,
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
  pauseCancelAlarmAfterSnapshot,
  pausePreparedAlarmAfterSnapshot,
  pauseAssignmentWriterPut,
)}
${stripExport(inventory)}
${stripExport(deletionInput)}
${stripExport(sagaStorage)}
${stripExport(sagaCancel)}
${stripExport(sagaFinalize)}
${stripExport(saga)}
${stripExport(inventoryFetch)}
${stripExport(inventoryEntityPort)}
${stripExport(identityReset)}
${stripExport(assignmentInput)}
${stripExport(appAssignment)}
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
  pauseCancelAlarmAfterSnapshot,
  pausePreparedAlarmAfterSnapshot,
  pauseAssignmentWriterPut,
)}
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__test/deadlock-barrier-status") {
      return Response.json({
        cancelKvDeleteReached: globalThis.__cancelKvDeleteReached,
        ensureRegisterAttempts: globalThis.__ensureRegisterAttempts,
        finalizeInventoryListReached: globalThis.__finalizeInventoryListReached,
        cancelAlarmSnapshotReached: globalThis.__cancelAlarmSnapshotReached,
        preparedAlarmSnapshotReached: globalThis.__preparedAlarmSnapshotReached,
        assignmentWriterPutReached: globalThis.__assignmentWriterPutReached,
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
    if (url.pathname === "/__test/release-cancel-alarm-snapshot" && request.method === "POST") {
      globalThis.__cancelAlarmSnapshotReleased = true;
      return Response.json({ released: true });
    }
    if (url.pathname === "/__test/release-prepared-alarm-snapshot" && request.method === "POST") {
      globalThis.__preparedAlarmSnapshotReleased = true;
      return Response.json({ released: true });
    }
    if (url.pathname === "/__test/release-assignment-writer-put" && request.method === "POST") {
      globalThis.__assignmentWriterPutReleased = true;
      return Response.json({ released: true });
    }
    return new Response("harness", { status: 200 });
  },
};
`;
}
