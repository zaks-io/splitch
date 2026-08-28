import {
  type Block,
  type ClassDeclaration,
  createSourceFile,
  type Expression,
  type FunctionDeclaration,
  isClassDeclaration,
  isExportAssignment,
  isFunctionDeclaration,
  isMethodDeclaration,
  type MethodDeclaration,
  ScriptKind,
  ScriptTarget,
  type SourceFile,
  SyntaxKind,
} from "typescript";
import {
  exportedFetchClasses,
  findExportedClass,
  isFetchPropertyName,
  unsupportedExportedFetchClasses,
} from "./hosted-worker-entrypoints.js";
import { blockPath, locationOf, type PathResult } from "./hosted-worker-wrap-ast.js";
import {
  expressionIsWrappedFetch,
  expressionWrapPath,
  functionWrapPath,
  WRAP_WORKER_HANDLER,
} from "./hosted-worker-wrap-resolve.js";

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
  const assignment = findDefaultExportAssignment(file);
  if (assignment) return wrapProofFromPath(expressionWrapPath(file, assignment, new Set()));
  const defaultFunction = findDefaultExportedFunction(file);
  if (defaultFunction) return wrapProofFromPath(functionWrapPath(file, defaultFunction, new Set()));
  const defaultClass = findDefaultExportedClass(file);
  if (defaultClass) return classFetchProof(file, defaultClass);
  return { wrapped: false, reason: "no default export", location: `${file.fileName}:1:1` };
}

export function proveClassFetchWrapped(
  source: string,
  className: string,
  fileName = "worker.ts",
): WrapProof {
  const file = parseSource(source, fileName);
  const cls = findExportedClass(file, className);
  if (!cls) {
    return {
      wrapped: false,
      reason: `class ${className} not found`,
      location: `${file.fileName}:1:1`,
    };
  }
  return classFetchProof(file, cls);
}

function parseSource(source: string, fileName: string): SourceFile {
  return createSourceFile(fileName, source, ScriptTarget.Latest, true, ScriptKind.TS);
}

function findDefaultExportAssignment(file: SourceFile): Expression | undefined {
  for (const statement of file.statements) {
    if (isExportAssignment(statement) && !statement.isExportEquals) return statement.expression;
  }
  return undefined;
}

function findDefaultExportedClass(file: SourceFile): ClassDeclaration | undefined {
  return file.statements.find(
    (statement): statement is ClassDeclaration =>
      isClassDeclaration(statement) && isDefaultExported(statement),
  );
}

function findDefaultExportedFunction(file: SourceFile): FunctionDeclaration | undefined {
  return file.statements.find(
    (statement): statement is FunctionDeclaration =>
      isFunctionDeclaration(statement) && isDefaultExported(statement),
  );
}

function isDefaultExported(node: { modifiers?: ClassDeclaration["modifiers"] }): boolean {
  return Boolean(
    node.modifiers?.some((modifier) => modifier.kind === SyntaxKind.ExportKeyword) &&
      node.modifiers?.some((modifier) => modifier.kind === SyntaxKind.DefaultKeyword),
  );
}

function classFetchProof(file: SourceFile, cls: ClassDeclaration): WrapProof {
  const fetch = cls.members.find(
    (member): member is MethodDeclaration =>
      isMethodDeclaration(member) && isFetchPropertyName(member.name),
  );
  if (!fetch) {
    return {
      wrapped: false,
      reason: `${cls.name?.text ?? "default class"} has no fetch method`,
      location: locationOf(file, cls),
    };
  }
  if (!fetch.body) {
    return {
      wrapped: false,
      reason: `${cls.name?.text ?? "default class"}.fetch has no body`,
      location: locationOf(file, fetch),
    };
  }
  return proofFromBlock(file, fetch.body, (expression) =>
    expressionIsWrappedFetch(file, expression),
  );
}

function wrapProofFromPath(path: PathResult): WrapProof {
  if (path.kind === "returns") return { wrapped: true };
  if (path.kind === "fail") {
    return { wrapped: false, reason: path.reason, location: path.location };
  }
  return { wrapped: false, reason: "not every reachable path returns a wrapped handler" };
}

function proofFromBlock(
  file: SourceFile,
  block: Block,
  predicate: (expression: Expression) => boolean,
): WrapProof {
  const path = blockPath(file, block, predicate);
  if (path.kind === "returns") return { wrapped: true };
  if (path.kind === "fail") {
    return { wrapped: false, reason: path.reason, location: path.location };
  }
  return {
    wrapped: false,
    reason: "not every reachable path returns a wrapped handler",
    location: locationOf(file, block),
  };
}
