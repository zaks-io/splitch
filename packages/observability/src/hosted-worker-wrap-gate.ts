import {
  type ClassDeclaration,
  createSourceFile,
  type Expression,
  isClassDeclaration,
  isExportAssignment,
  isIdentifier,
  isMethodDeclaration,
  type MethodDeclaration,
  type PropertyName,
  ScriptKind,
  ScriptTarget,
  type SourceFile,
  SyntaxKind,
} from "typescript";
import { blockPath } from "./hosted-worker-wrap-path";
import {
  expressionIsWrap,
  fetchReturnIsWrapped,
  WRAP_WORKER_HANDLER,
} from "./hosted-worker-wrap-resolve";

export { WRAP_WORKER_HANDLER };

export function defaultExportIsWrapped(source: string): boolean {
  const file = parseSource(source);
  const exported = findDefaultExport(file);
  if (exported) return expressionIsWrap(file, exported, new Set());
  const cls = findDefaultExportClass(file);
  return cls?.name ? classFetchIsWrapped(source, cls.name.text) : false;
}

export function exportedWorkerEntrypoints(source: string): string[] {
  const file = parseSource(source);
  const names: string[] = [];
  for (const statement of file.statements) {
    if (!isClassDeclaration(statement) || !isExported(statement) || !statement.name) continue;
    if (extendsWorkerEntrypoint(statement)) names.push(statement.name.text);
  }
  return names;
}

export function classFetchIsWrapped(source: string, className: string): boolean {
  const file = parseSource(source);
  const cls = file.statements.find(
    (statement): statement is ClassDeclaration =>
      isClassDeclaration(statement) && statement.name?.text === className,
  );
  if (!cls) return false;
  const fetch = cls.members.find(
    (member): member is MethodDeclaration =>
      isMethodDeclaration(member) && isFetchName(member.name),
  );
  if (!fetch?.body) return false;
  return (
    blockPath(fetch.body, (expression) => fetchReturnIsWrapped(file, expression, fetch)) ===
    "returns"
  );
}

function parseSource(source: string): SourceFile {
  return createSourceFile("worker.ts", source, ScriptTarget.Latest, true, ScriptKind.TS);
}

function findDefaultExport(file: SourceFile): Expression | undefined {
  for (const statement of file.statements) {
    if (isExportAssignment(statement) && !statement.isExportEquals) return statement.expression;
  }
  return undefined;
}

function findDefaultExportClass(file: SourceFile): ClassDeclaration | undefined {
  return file.statements.find(
    (statement): statement is ClassDeclaration =>
      isClassDeclaration(statement) &&
      Boolean(
        statement.modifiers?.some((modifier) => modifier.kind === SyntaxKind.DefaultKeyword),
      ) &&
      extendsWorkerEntrypoint(statement),
  );
}

function isExported(node: ClassDeclaration): boolean {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === SyntaxKind.ExportKeyword));
}

function extendsWorkerEntrypoint(cls: ClassDeclaration): boolean {
  return (cls.heritageClauses ?? []).some(
    (clause) =>
      clause.token === SyntaxKind.ExtendsKeyword &&
      clause.types.some(
        (type) => isIdentifier(type.expression) && type.expression.text === "WorkerEntrypoint",
      ),
  );
}

function isFetchName(name: PropertyName): boolean {
  return isIdentifier(name) && name.text === "fetch";
}
