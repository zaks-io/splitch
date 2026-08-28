import { createSourceFile, ScriptKind, ScriptTarget, type SourceFile } from "typescript";
import {
  exportedFetchClasses,
  findExportedClass,
  unsupportedExportedFetchClasses,
} from "./hosted-worker-entrypoints.js";
import { canonicalClassProof } from "./hosted-worker-canonical-class.js";
import { canonicalDefaultExportProof } from "./hosted-worker-canonical.js";
import { WRAP_WORKER_HANDLER } from "./hosted-worker-wrap-scope.js";

export { WRAP_WORKER_HANDLER };

export type WrapProof = {
  readonly wrapped: boolean;
  readonly reason?: string;
  readonly location?: string;
};

export function defaultExportIsWrapped(source: string, fileName = "worker.ts"): boolean {
  return proveDefaultExportWrapped(source, fileName).wrapped;
}

export function exportedWorkerEntrypoints(source: string, fileName = "worker.ts"): string[] {
  const file = parseSource(source, fileName);
  return exportedFetchClasses(file)
    .filter((entry) => entry.workerEntrypoint)
    .map((entry) => entry.exportName);
}

export function unsupportedExportedFetchFailures(source: string, fileName = "worker.ts"): string[] {
  const file = parseSource(source, fileName);
  return unsupportedExportedFetchClasses(file).map(
    (entry) => `unsupported exported fetch-bearing class ${entry.exportName} (${entry.location})`,
  );
}

export function classFetchIsWrapped(
  source: string,
  className: string,
  fileName = "worker.ts",
): boolean {
  return proveClassFetchWrapped(source, className, fileName).wrapped;
}

export function proveDefaultExportWrapped(source: string, fileName = "worker.ts"): WrapProof {
  const file = parseSource(source, fileName);
  return canonicalDefaultExportProof(file);
}

export function proveClassFetchWrapped(
  source: string,
  className: string,
  fileName = "worker.ts",
): WrapProof {
  const file = parseSource(source, fileName);
  const exported = exportedFetchClasses(file).find(
    (entry) => entry.exportName === className || entry.className === className,
  );
  const cls = exported?.declaration ?? findExportedClass(file, className);
  if (!cls) {
    return {
      wrapped: false,
      reason: `class ${className} not found`,
      location: `${file.fileName}:1:1`,
    };
  }
  return canonicalClassProof(file, cls);
}

function parseSource(source: string, fileName: string): SourceFile {
  return createSourceFile(fileName, source, ScriptTarget.Latest, true, ScriptKind.TS);
}
